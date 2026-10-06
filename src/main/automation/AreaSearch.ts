/**
 * Searching every room within so many moves of the character, each so many
 * times (the player's *Search the area*). The rooms and their order are the
 * navigation engine's reach (`AreaPlan`); each room is one walk and its
 * searches (`Collect`, with nothing named, so every search is sent). What a
 * search turns up is the loot's and the room log's, as for any search. Waits
 * out a fight, a rest and the loot's `get`s between rooms. Never walks into
 * a room the plan left out for its fight (`AreaPlan.lose`, `unread`). A leg
 * a fight ended is planned again once; a room the walk still cannot reach is
 * passed over. A run away, being attacked with auto-combat off, leaving the
 * realm, a death, the player's stop and three rooms missed in a row end it. See `mudengine-automation` ›
 * *Searching the area walks each room once*.
 */
import { Collect, type CollectEnd, type CollectPlanner } from './Collect';
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { AreaPlan, AreaSearchPreview } from '../../shared/areaSearch';
import type { SafetyDecision } from '../../shared/automation';
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import type { RoomId, Route } from '../../shared/world';
import type { SessionModule } from './Module';

export interface AreaSearchPlanner extends Omit<CollectPlanner, 'routeTo'> {
  /** The rooms within `radius` moves of here, in walking order, or why there are none. */
  plan(radius: number): AreaPlan | string;
  /** A route to the room that enters none of `walled`, or the reason there is none. */
  routeAround(room: RoomId, walled: ReadonlySet<RoomId>): Route | string;
  /** Auto-combat fights what attacks: on, with the master switch. */
  fightsBack(): boolean;
  /** The room's name, as the realm states it. */
  nameOf(room: RoomId): string;
  moveInFlight(): boolean;
  walking(): boolean;
  looping(): boolean;
  /** Another trip has the character. */
  busy(): boolean;
  /** The character is running away. */
  escaping(): boolean;
  /** The loot has a `get` waiting for what a search turned up. */
  taking(): boolean;
  /** A fight here, or one auto-combat is about to open. */
  fighting(): boolean;
}

export interface AreaSearchEvents {
  notice?(message: string): void;
  decided?(decision: SafetyDecision): void;
}

interface Run {
  plan: AreaPlan;
  searches: number;
  /** The rooms searched, and those passed over. */
  done: Set<RoomId>;
  searched: number;
  missed: number;
  /** The rooms left out for their fight, which no walk enters. */
  walled: ReadonlySet<RoomId>;
  /** The room the walk or the searches under way are for. */
  target: RoomId | null;
  /** The rooms whose walk a fight or a hold already ended once, each planned again once. */
  retried: Set<RoomId>;
  /** Rooms missed since the last one searched. */
  missedInARow: number;
  /** Between rooms: the next walk starts when nothing holds the character. */
  between: boolean;
}

const ACTION = 'search the area';

export class AreaSearch implements SessionModule {
  private readonly collect: Collect;
  private run: Run | null = null;

  constructor(
    private enabled: boolean,
    queue: CommandQueue,
    private readonly planner: AreaSearchPlanner,
    private readonly events: AreaSearchEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {
    const walled = (): ReadonlySet<RoomId> => this.run?.walled ?? new Set();
    this.collect = new Collect(
      queue,
      { ...planner, routeTo: (room) => planner.routeAround(room, walled()) },
      { ended: (end) => this.ended(end) },
      now
    );
  }

  configure(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.finish(t('automation.areaSearch.endedSwitchedOff'));
  }

  reset(): void {
    this.collect.cancel();
    this.run = null;
  }

  get busy(): boolean {
    return this.run !== null;
  }

  /**
   * The rooms a search of this radius would walk, for the dialog, or why there
   * are none; null asks at the radius the dialog first offers.
   */
  preview(asked: number | null): AreaSearchPreview {
    const { maxRadius, maxSearches, firstRadius, firstSearches } = tuning().areaSearch;
    const radius = asked ?? firstRadius;
    const plan = this.planner.plan(radius);
    const bounds = { maxRadius, maxSearches, firstRadius, firstSearches };
    const combatOff = !this.planner.fightsBack();
    if (typeof plan === 'string') return { ...bounds, combatOff, plan: { refused: plan } };
    const names = (rooms: readonly RoomId[]): string[] =>
      rooms.map((room) => this.planner.nameOf(room));
    return {
      ...bounds,
      combatOff,
      plan: {
        rooms: plan.tour.length,
        steps: plan.steps,
        lose: names(plan.lose),
        unread: names(plan.unread),
        behind: names(plan.behind),
        stranded: names(plan.stranded)
      }
    };
  }

  /** Starts the search; its refusal, said and traced, or null once under way. */
  start(radius: number, searches: number, state: CharacterState): string | null {
    const why = this.whyNot(state);
    if (why !== null) return this.refuse(why);
    const plan = this.planner.plan(radius);
    if (typeof plan === 'string') return this.refuse(plan);
    if (plan.tour.length === 0) return this.refuse(t('automation.areaSearch.refusalNoRooms'));
    this.run = {
      plan,
      searches,
      done: new Set(),
      searched: 0,
      missed: 0,
      walled: new Set(plan.walled),
      target: null,
      retried: new Set(),
      missedInARow: 0,
      between: false
    };
    const figures = { rooms: plan.tour.length, radius, steps: plan.steps, searches };
    this.events.notice?.(
      searches === 1
        ? t('automation.areaSearch.starting.one', figures)
        : t('automation.areaSearch.starting.many', figures)
    );
    this.next(state);
    return null;
  }

  /** The player's stop, through `Travel.stopMoving`: ended before the walk's end is heard. */
  stop(reason: string): void {
    this.finish(t('automation.areaSearch.endedStopped', { why: reason }));
  }

  /** A death: the rooms are somewhere else now. */
  abandon(): void {
    this.finish(t('automation.areaSearch.endedDied'));
  }

  onBlock(block: Block): void {
    this.collect.onBlock(block);
  }

  onCharacter(state: CharacterState): void {
    const run = this.run;
    if (run === null) return;
    const ended = this.endedBy(state);
    if (ended !== null) {
      this.finish(ended);
      return;
    }
    this.collect.onCharacter(state);
    if (this.run !== run || !run.between || this.held(state)) return;
    run.between = false;
    this.next(state);
  }

  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    this.collect.onWalkEnded(arrived, reason, state);
  }

  /** What ends the search whatever room it is in, or null. */
  private endedBy(state: CharacterState): string | null {
    if (state.phase !== 'in-game') return t('automation.areaSearch.endedLeftRealm');
    if (this.planner.escaping()) return t('automation.areaSearch.endedRanAway');
    // Nothing fights back, so the next room is only further into whatever is here.
    if (this.planner.fighting() && !this.planner.fightsBack()) {
      return t('automation.areaSearch.endedAttacked');
    }
    return null;
  }

  /** What keeps the character in this room a while longer, between two rooms. */
  private held(state: CharacterState): boolean {
    return (
      this.planner.fighting() ||
      state.vitals.resting ||
      state.vitals.meditating ||
      this.planner.moveInFlight() ||
      this.planner.walking() ||
      this.planner.taking()
    );
  }

  private whyNot(state: CharacterState): string | null {
    if (!this.enabled) return t('automation.areaSearch.refusalSwitchedOff');
    if (state.phase !== 'in-game') return t('automation.areaSearch.refusalNotInRealm');
    if (this.run !== null) return t('automation.areaSearch.refusalRunning');
    if (this.planner.fighting()) return t('automation.areaSearch.refusalFighting');
    if (this.planner.looping()) return t('automation.areaSearch.refusalLooping');
    if (this.planner.moveInFlight() || this.planner.walking() || this.planner.busy()) {
      return t('automation.areaSearch.refusalBusy');
    }
    return null;
  }

  /**
   * The walk to the next room not yet done. Where the way there passes a room
   * still to search, the walk stops there first, so no room is walked
   * through unsearched and come back to.
   */
  private next(state: CharacterState): void {
    const run = this.run;
    if (run === null) return;
    // Each pass marks a room done or starts a walk, so this ends.
    while (this.run === run) {
      const room = run.plan.tour.find((each) => !run.done.has(each));
      if (room === undefined) {
        this.finish(null);
        return;
      }
      const to = this.firstOnTheWay(run, room);
      if (to === null) {
        this.missed(run, room);
        continue;
      }
      const { collectMs } = tuning().areaSearch;
      run.target = to;
      const started = this.collect.start(
        {
          to,
          items: [],
          search: { times: run.searches, reason: t('automation.areaSearch.reasonSearch') },
          key: 'area',
          reason: () => t('automation.areaSearch.reasonSearch'),
          collectMs,
          // Read only for a `get`, and nothing is named.
          expiresMs: tuning().search.expiresMs
        },
        state
      );
      if (started.kind !== 'refused') return;
      run.target = null;
      this.missed(run, to);
    }
  }

  /** The room itself, or a room still to search the way there passes first; null with no way. */
  private firstOnTheWay(run: Run, room: RoomId): RoomId | null {
    const route = this.planner.routeAround(room, run.walled);
    if (typeof route === 'string' || route.blocked) return null;
    const tour = new Set(run.plan.tour);
    return route.steps.find((step) => tour.has(step.to) && !run.done.has(step.to))?.to ?? room;
  }

  private ended(end: CollectEnd): void {
    const run = this.run;
    if (run === null) return;
    const room = run.target;
    run.target = null;
    if (room === null) return;
    switch (end.kind) {
      // A leg a fight or a hold ended: planned again from wherever it ended, once.
      case 'not-reached':
        if (run.retried.has(room)) this.missed(run, room);
        else run.retried.add(room);
        break;
      case 'left':
        this.missed(run, room);
        break;
      // No search went out (the queue would take none): the room was not searched.
      case 'nothing-here':
        if (end.searches === 0) this.missed(run, room);
        else this.searchedIn(run, room);
        break;
      case 'taken':
        this.searchedIn(run, room);
        break;
      default: {
        const never: never = end;
        return never;
      }
    }
    if (this.run === run) run.between = true;
  }

  private searchedIn(run: Run, room: RoomId): void {
    run.done.add(room);
    run.searched += 1;
    run.missedInARow = 0;
    this.events.notice?.(
      t('automation.areaSearch.searched', {
        room: this.planner.nameOf(room),
        done: run.done.size,
        rooms: run.plan.tour.length
      })
    );
  }

  private missed(run: Run, room: RoomId): void {
    run.done.add(room);
    run.missed += 1;
    run.missedInARow += 1;
    this.events.notice?.(t('automation.areaSearch.missed', { room: this.planner.nameOf(room) }));
    if (run.missedInARow >= tuning().areaSearch.missedInARow) {
      this.finish(t('automation.areaSearch.endedMissed', { missed: run.missedInARow }));
    }
  }

  /** The run over: what came of it said and traced. */
  private finish(refused: string | null): void {
    const run = this.run;
    this.collect.cancel();
    this.run = null;
    if (run === null) return;
    const { searched, missed } = run;
    const because = t('automation.areaSearch.because', { radius: run.plan.radius });
    if (refused !== null) this.events.notice?.(refused);
    this.events.notice?.(t('automation.areaSearch.done', { searched, missed }));
    this.events.decided?.({ at: this.now(), action: ACTION, because, acted: searched > 0 });
  }

  private refuse(why: string): string {
    const sentence = t('automation.areaSearch.refused', { why });
    this.events.notice?.(sentence);
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.areaSearch.becauseAsked'),
      acted: false,
      refused: sentence
    });
    return why;
  }
}
