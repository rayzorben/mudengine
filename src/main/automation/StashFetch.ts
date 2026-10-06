/**
 * Going to a room and taking named items out of what was hidden there (todo
 * 05, 2026-10-03): the character's own stash, or what a search turned up
 * there (todo 17, the area search's finds). Started only by an extension through the host
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
import { roomId, type RoomId } from '../../shared/world';
import { asRoomAndItems, tripRefusal, type TripPlanner } from './askedTrip';
import type { SessionModule } from './Module';

export interface StashFetchPlanner extends CollectPlanner, TripPlanner {}

export interface StashFetchEvents {
  notice?(message: string): void;
  decided?(decision: SafetyDecision): void;
}

/** Whose the pile is: what the character hid, or what a search turned up. */
export type FetchSource = 'stash' | 'finds';

/** What an extension asks for: the room, the items as the pack names them, whether to search, and whose. */
export interface StashFetchAsk {
  room: RoomId;
  items: readonly string[];
  search: boolean;
  source: FetchSource;
}

/** The trip under way, as a card reads it. */
export interface StashTrip {
  room: RoomId;
  items: readonly string[];
  source: FetchSource;
  stage: CollectStage;
}

/** An extension's ask, parsed at the boundary (`asRoomAndItems`); unread, the stash's. */
export function asStashFetchAsk(value: unknown): StashFetchAsk | null {
  const asked = asRoomAndItems(value);
  if (asked === null) return null;
  const { search, source } = value as Record<string, unknown>;
  return { ...asked, search: search === true, source: source === 'finds' ? 'finds' : 'stash' };
}

/** The trace's word for the trip. */
function actionOf(source: FetchSource): string {
  return source === 'finds' ? 'fetch a find' : 'fetch from stash';
}

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
    if (!enabled && this.trip !== null) this.finish(t('automation.hostTrip.endedSwitchedOff'));
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
    const { room, items, source } = this.trip.ask;
    return { room, items, source, stage };
  }

  /** A death: the room it was walking to is somewhere else now. */
  abandon(): void {
    if (this.trip !== null) this.finish(t('automation.hostTrip.endedDied'));
  }

  /** One trip; its refusal, said and traced, or null once under way. */
  fetch(ask: StashFetchAsk, state: CharacterState): string | null {
    // The room as the stash record names it, where it does.
    const place =
      state.stash.find(
        (entry) =>
          entry.map !== null && entry.room !== null && roomId(entry.map, entry.room) === ask.room
      )?.name ?? ask.room;
    const trip = { enabled: this.enabled, running: this.trip !== null };
    const why = tripRefusal(ask.items, trip, state, this.planner);
    if (why !== null) {
      this.refuse(ask, place, why);
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
        reason: (item) =>
          ask.source === 'finds'
            ? t('automation.stashFetch.finds.reasonTaking', { item })
            : t('automation.stashFetch.reasonTaking', { item }),
        collectMs,
        expiresMs
      },
      state
    );
    if (started.kind === 'refused') {
      this.release();
      this.refuse(ask, place, started.why);
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

  private ended(end: CollectEnd): void {
    switch (end.kind) {
      case 'not-reached':
        this.finish(
          t('automation.hostTrip.endedNotReached', {
            why: end.why ?? t('automation.hostTrip.whyStopped')
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
      const items = taken.join(', ');
      this.events.notice?.(
        trip.ask.source === 'finds'
          ? t('automation.stashFetch.finds.done', { items })
          : t('automation.stashFetch.done', { items })
      );
      this.events.decided?.({
        at: this.now(),
        action: actionOf(trip.ask.source),
        because: this.because(trip.ask, trip.place),
        acted: true
      });
    }
    if (refused !== null) this.refuse(trip.ask, trip.place, refused);
  }

  private release(): void {
    const held = this.trip?.held ?? false;
    this.trip = null;
    if (held) this.planner.release();
  }

  private because(ask: StashFetchAsk, room: string): string {
    const items = ask.items.join(', ');
    return ask.source === 'finds'
      ? t('automation.stashFetch.finds.because', { items, room })
      : t('automation.stashFetch.because', { items, room });
  }

  private refuse(ask: StashFetchAsk, place: string, why: string): void {
    const sentence =
      ask.source === 'finds'
        ? t('automation.stashFetch.finds.refused', { why })
        : t('automation.stashFetch.refused', { why });
    this.events.notice?.(sentence);
    this.events.decided?.({
      at: this.now(),
      action: actionOf(ask.source),
      because: this.because(ask, place),
      acted: false,
      refused: sentence
    });
  }
}
