/**
 * Going to a room and taking named items out of what was hidden there (todo
 * 05, 2026-10-03). Started only by an extension through the host
 * (`stash.fetch`), never by the client itself: the client supplies the walk,
 * the searches and the pick-up (`Collect`), and decides nothing about what to
 * fetch or when. Yields to a fight, a rest, a move, a walk and every other
 * trip; walks as a leg; holds the lap; dropped on a death; says every refusal
 * and how each trip ended. See `mudengine-automation` › *Outgrown gear is
 * stashed, sold or dropped*.
 */
import { Collect, type CollectEnd, type CollectPlanner, type CollectStage } from './Collect';
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import { asRoomReference, roomId, type RoomId } from '../../shared/world';
import type { SessionModule } from './Module';

export interface StashFetchPlanner extends CollectPlanner {
  moveInFlight(): boolean;
  walking(): boolean;
  /** An escape or another trip has the character. */
  busy(): boolean;
  looping(): boolean;
  /** Holds the lap for the trip, and gives it back. */
  hold(): void;
  release(): void;
}

export interface StashFetchEvents {
  notice?(message: string): void;
  decided?(decision: SafetyDecision): void;
}

/** What an extension asks for: the room, the items as the pack names them, and whether to search. */
export interface StashFetchAsk {
  room: RoomId;
  items: readonly string[];
  search: boolean;
}

/** The trip under way, as a card reads it. */
export interface StashTrip {
  room: RoomId;
  items: readonly string[];
  stage: CollectStage;
}

/**
 * An extension's ask, parsed at the boundary: an extension is JavaScript the
 * client did not build, so a room that is not `map/room` or a list with no
 * name in it is no ask at all.
 */
export function asStashFetchAsk(value: unknown): StashFetchAsk | null {
  if (typeof value !== 'object' || value === null) return null;
  const { room, items, search } = value as Record<string, unknown>;
  const place = typeof room === 'string' ? asRoomReference(room) : null;
  if (place === null || !Array.isArray(items)) return null;
  const named = items.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0
  );
  if (named.length !== items.length) return null;
  return { room: roomId(place.map, place.room), items: named, search: search === true };
}

const ACTION = 'fetch from stash';

export class StashFetch implements SessionModule {
  private readonly collect: Collect;
  private trip: { ask: StashFetchAsk; place: string; held: boolean } | null = null;
  /** How the last trip ended, where it ended in a refusal: read when one ends before `fetch` returns. */
  private endedWith: string | null = null;

  constructor(
    private enabled: boolean,
    queue: CommandQueue,
    private readonly planner: StashFetchPlanner,
    private readonly events: StashFetchEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {
    this.collect = new Collect(
      queue,
      planner,
      {
        taking: (taking) =>
          this.events.notice?.(t('automation.stashFetch.taking', { items: taking.join(', ') })),
        ended: (end) => this.ended(end)
      },
      now
    );
  }

  configure(enabled: boolean): void {
    this.enabled = enabled;
    // Switched off mid-trip: nothing is taken on arrival, and the lap goes back.
    if (!enabled && this.trip !== null) this.finish(t('automation.stashFetch.endedSwitchedOff'));
  }

  reset(): void {
    this.collect.cancel();
    this.trip = null;
  }

  get busy(): boolean {
    return this.trip !== null;
  }

  get current(): StashTrip | null {
    const stage = this.collect.stage;
    if (this.trip === null || stage === null) return null;
    return { room: this.trip.ask.room, items: this.trip.ask.items, stage };
  }

  /** A death: the room it was walking to is somewhere else now. */
  abandon(): void {
    if (this.trip !== null) this.finish(t('automation.stashFetch.endedDied'));
  }

  /** One trip; its refusal, said and traced, or null once under way. */
  fetch(ask: StashFetchAsk, state: CharacterState): string | null {
    // The room as the stash record names it, where it does.
    const place =
      state.stash.find(
        (entry) =>
          entry.map !== null && entry.room !== null && roomId(entry.map, entry.room) === ask.room
      )?.name ?? ask.room;
    const why = this.whyNot(ask, state);
    if (why !== null) {
      this.refuse(ask.items, place, why);
      return why;
    }
    const held = this.planner.looping();
    this.trip = { ask, place, held };
    if (held) this.planner.hold();
    const { searches, collectMs, expiresMs } = tuning().stashFetch;
    const started = this.collect.start(
      {
        to: ask.room,
        items: ask.items,
        search: ask.search
          ? { times: searches, reason: t('automation.stashFetch.reasonSearch') }
          : null,
        key: 'stash',
        reason: (item) => t('automation.stashFetch.reasonTaking', { item }),
        collectMs,
        expiresMs
      },
      state
    );
    if (started.kind === 'refused') {
      this.release();
      this.refuse(ask.items, place, started.why);
      return started.why;
    }
    if (started.kind === 'walking') {
      this.events.notice?.(
        t('automation.stashFetch.going', {
          items: ask.items.join(', '),
          room: place,
          steps: started.steps
        })
      );
    }
    // Standing there with nothing on the floor ends the trip inside `start`.
    return this.trip === null ? this.endedWith : null;
  }

  onBlock(block: Block): void {
    this.collect.onBlock(block);
  }

  onCharacter(state: CharacterState): void {
    if (this.trip !== null) this.collect.onCharacter(state);
  }

  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    this.collect.onWalkEnded(arrived, reason, state);
  }

  private whyNot(ask: StashFetchAsk, state: CharacterState): string | null {
    if (!this.enabled) return t('automation.stashFetch.refusalSwitchedOff');
    if (state.phase !== 'in-game') return t('automation.stashFetch.refusalNotInRealm');
    if (this.trip !== null) return t('automation.stashFetch.refusalBusy');
    if (ask.items.length === 0) return t('automation.stashFetch.refusalNothingNamed');
    if (state.inCombat || state.combat.attackers.length > 0) {
      return t('automation.stashFetch.refusalFighting');
    }
    if (state.vitals.resting || state.vitals.meditating) {
      return t('automation.stashFetch.refusalResting');
    }
    if (this.planner.moveInFlight() || this.planner.walking() || this.planner.busy()) {
      return t('automation.stashFetch.refusalBusy');
    }
    return null;
  }

  private ended(end: CollectEnd): void {
    switch (end.kind) {
      case 'not-reached':
        this.finish(
          t('automation.stashFetch.endedNotReached', {
            why: end.why ?? t('automation.stashFetch.whyStopped')
          })
        );
        return;
      case 'left':
        this.finish(t('automation.stashFetch.endedLeft'));
        return;
      case 'nothing-here':
        this.finish(
          end.searches > 1
            ? t('automation.stashFetch.endedNothingHere.many', { searches: end.searches })
            : end.searches === 1
              ? t('automation.stashFetch.endedNothingHere.one')
              : t('automation.stashFetch.endedNothingOnTheFloor')
        );
        return;
      case 'taken': {
        const missed = end.asked.filter((item) => !end.arrived.includes(item));
        this.finish(
          missed.length === 0
            ? null
            : t('automation.stashFetch.endedMissed', { items: missed.join(', ') }),
          end.arrived
        );
        return;
      }
      default: {
        const never: never = end;
        return never;
      }
    }
  }

  /** The trip over: what came of it said and traced, and the lap given back. */
  private finish(refused: string | null, taken: readonly string[] = []): void {
    const trip = this.trip;
    this.collect.cancel();
    this.endedWith = refused;
    if (trip === null) return;
    this.release();
    if (refused === null || taken.length > 0) {
      this.events.notice?.(t('automation.stashFetch.done', { items: taken.join(', ') }));
      this.events.decided?.({
        at: this.now(),
        action: ACTION,
        because: this.because(trip.ask.items, trip.place),
        acted: true
      });
    }
    if (refused !== null) this.refuse(trip.ask.items, trip.place, refused);
  }

  private release(): void {
    const held = this.trip?.held ?? false;
    this.trip = null;
    if (held) this.planner.release();
  }

  private because(items: readonly string[], place: string): string {
    return t('automation.stashFetch.because', { items: items.join(', '), room: place });
  }

  private refuse(items: readonly string[], place: string, why: string): void {
    const sentence = t('automation.stashFetch.refused', { why });
    this.events.notice?.(sentence);
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: this.because(items, place),
      acted: false,
      refused: sentence
    });
  }
}
