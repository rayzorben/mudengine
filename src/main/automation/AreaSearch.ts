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
 * realm, a death, the player's stop and three rooms missed in a row end it.
 * The run is kept once over (`last`): each room searched and what its floors
 * held as the walk went on. See `mudengine-automation` › *Searching the area
 * walks each room once*.
 */
import { Collect, type CollectEnd, type CollectPlanner } from './Collect';
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import {
  areaLimits,
  type AreaLimits,
  type AreaPlan,
  type AreaSearched,
  type AreaSearchEnding,
  type AreaSearchPreview,
  type FloorThing,
  type SearchedRoom
} from '../../shared/areaSearch';
import type { AutomationConfig, SearchConfig } from '../../shared/config';
import type { SafetyDecision } from '../../shared/automation';
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import type { NoticeSink } from '../../shared/decisionSettings';
import { roomAddress, type RoomId, type Route } from '../../shared/world';
import type { SessionModule } from './Module';
import { tripEndedBy, tripHeld, tripRefusal, type TripEnd, type TripRefusal } from './tripGuards';

/** The master switch, and the bounds the settings put on the dialog. */
export type AreaSearchSettings = Pick<AutomationConfig, 'enabled'> & {
  search: Pick<SearchConfig, 'areaMaxSteps' | 'areaMaxSearches'>;
};

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
  notice?: NoticeSink;
  decided?(decision: SafetyDecision): void;
}

interface Run {
  plan: AreaPlan;
  searches: number;
  startedAt: number;
  /** The rooms searched, in the order walked, each with its floors as last read there. */
  rooms: SearchedRoom[];
  /** The room just searched, whose floors are read on every line while the character stands in it. */
  leaving: SearchedRoom | null;
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

/** What both floors of the room stood in hold, coins aside. */
function floorOf(state: CharacterState): FloorThing[] {
  const { items, hidden } = state.room;
  const thing =
    (hidden: boolean) =>
    (item: { name: string; count?: number }): FloorThing => ({
      name: item.name,
      count: item.count ?? 1,
      hidden
    });
  return [...items.map(thing(false)), ...hidden.map(thing(true))];
}

export class AreaSearch implements SessionModule {
  private readonly collect: Collect;
  private run: Run | null = null;
  private ran: AreaSearched | null = null;

  constructor(
    private settings: AreaSearchSettings,
    queue: CommandQueue,
    private readonly planner: AreaSearchPlanner,
    private readonly events: AreaSearchEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {
    const walled = (): ReadonlySet<RoomId> => this.run?.walled ?? new Set();
    this.collect = new Collect(
      queue,
      { ...planner, routeTo: (room) => planner.routeAround(room, walled()) },
      { ended: (end, state) => this.ended(end, state) },
      now
    );
  }

  configure(settings: AreaSearchSettings): void {
    this.settings = settings;
    if (!settings.enabled) this.finish('switched-off', t('automation.areaSearch.endedSwitchedOff'));
  }

  reset(): void {
    this.collect.cancel();
    this.run = null;
  }

  get busy(): boolean {
    return this.run !== null;
  }

  /** The last search, once over; null before one has ended. */
  get last(): AreaSearched | null {
    return this.ran;
  }

  /**
   * The rooms a search of this radius would walk, for the dialog, or why there
   * are none; null asks at the radius the dialog first offers.
   */
  preview(asked: number | null): AreaSearchPreview {
    const bounds = this.limits();
    const radius = asked ?? bounds.firstRadius;
    const plan = this.planner.plan(radius);
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
        hazard: hazardsOf(plan, names),
        behind: names(plan.behind),
        stranded: names(plan.stranded)
      }
    };
  }

  /** The dialog's bounds, as the settings stand. */
  limits(): AreaLimits {
    const { firstRadius, firstSearches } = tuning().areaSearch;
    return areaLimits(this.settings.search, { firstRadius, firstSearches });
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
      startedAt: this.now(),
      rooms: [],
      leaving: null,
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
        : t('automation.areaSearch.starting.many', figures),
      'area-search'
    );
    this.next(state);
    return null;
  }

  /** The player's stop, through `Travel.stopMoving`: ended before the walk's end is heard. */
  stop(reason: string): void {
    this.finish('stopped', t('automation.areaSearch.endedStopped', { why: reason }));
  }

  /** A death: the rooms are somewhere else now. */
  abandon(): void {
    this.finish('died', t('automation.areaSearch.endedDied'));
  }

  onBlock(block: Block): void {
    this.collect.onBlock(block);
  }

  onCharacter(state: CharacterState): void {
    const run = this.run;
    if (run === null) return;
    this.reread(run, state);
    const ended = tripEndedBy(this.planner, state);
    if (ended !== null) {
      this.finish(ended, this.endWords(ended));
      return;
    }
    this.collect.onCharacter(state);
    if (this.run !== run || !run.between || tripHeld(this.planner, state)) return;
    run.between = false;
    this.next(state);
  }

  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    this.collect.onWalkEnded(arrived, reason, state);
  }

  /** The search's words for what ended it (`tripEndedBy`). */
  private endWords(end: TripEnd): string {
    switch (end) {
      case 'left-realm':
        return t('automation.areaSearch.endedLeftRealm');
      case 'ran-away':
        return t('automation.areaSearch.endedRanAway');
      case 'attacked':
        return t('automation.areaSearch.endedAttacked');
      default: {
        const never: never = end;
        return never;
      }
    }
  }

  private whyNot(state: CharacterState): string | null {
    if (!this.settings.enabled) return t('automation.areaSearch.refusalSwitchedOff');
    const why = tripRefusal(this.planner, state, this.run !== null);
    return why === null ? null : this.refusalWords(why);
  }

  /** The search's words for why it cannot start (`tripRefusal`). */
  private refusalWords(why: TripRefusal): string {
    switch (why) {
      case 'not-in-realm':
        return t('automation.areaSearch.refusalNotInRealm');
      case 'running':
        return t('automation.areaSearch.refusalRunning');
      case 'fighting':
        return t('automation.areaSearch.refusalFighting');
      case 'looping':
        return t('automation.areaSearch.refusalLooping');
      case 'busy':
        return t('automation.areaSearch.refusalBusy');
      default: {
        const never: never = why;
        return never;
      }
    }
  }

  /**
   * The walk to the next room not yet done. Where the way there passes a room
   * still to search, the walk stops there first, so no room is walked
   * through unsearched and come back to.
   */
  private next(state: CharacterState): void {
    const run = this.run;
    if (run === null) return;
    this.reread(run, state);
    run.leaving = null;
    // Each pass marks a room done or starts a walk, so this ends.
    while (this.run === run) {
      const room = run.plan.tour.find((each) => !run.done.has(each));
      if (room === undefined) {
        this.finish('searched', null);
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
          expiresMs: tuning().search.expiresMs,
          decision: 'area-search'
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

  private ended(end: CollectEnd, state: CharacterState): void {
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
        else this.searchedIn(run, room, state);
        break;
      case 'taken':
        this.searchedIn(run, room, state);
        break;
      default: {
        const never: never = end;
        return never;
      }
    }
    if (this.run === run) run.between = true;
  }

  private searchedIn(run: Run, room: RoomId, state: CharacterState): void {
    run.done.add(room);
    run.searched += 1;
    run.missedInARow = 0;
    const searched = {
      room,
      name: this.planner.nameOf(room),
      floor: roomAddress(state.room) === room ? floorOf(state) : null
    };
    run.rooms.push(searched);
    run.leaving = searched;
    this.events.notice?.(
      t('automation.areaSearch.searched', {
        room: this.planner.nameOf(room),
        done: run.done.size,
        rooms: run.plan.tour.length
      }),
      'area-search'
    );
  }

  /**
   * The room just searched, read again on every line the character stands in
   * it: what the loot takes comes off it as the pack confirms, so however the
   * search ends, its last room is as the character left it.
   */
  private reread(run: Run, state: CharacterState): void {
    const left = run.leaving;
    if (left !== null && roomAddress(state.room) === left.room) left.floor = floorOf(state);
  }

  private missed(run: Run, room: RoomId): void {
    run.done.add(room);
    run.missed += 1;
    run.missedInARow += 1;
    this.events.notice?.(
      t('automation.areaSearch.missed', { room: this.planner.nameOf(room) }),
      'area-search'
    );
    if (run.missedInARow >= tuning().areaSearch.missedInARow) {
      this.finish('missed', t('automation.areaSearch.endedMissed', { missed: run.missedInARow }));
    }
  }

  /** The run over: what came of it said and traced. */
  private finish(ending: AreaSearchEnding, refused: string | null): void {
    const run = this.run;
    this.collect.cancel();
    this.run = null;
    if (run === null) return;
    const { searched, missed } = run;
    this.ran = {
      startedAt: run.startedAt,
      endedAt: this.now(),
      ending,
      radius: run.plan.radius,
      rooms: run.rooms
    };
    const because = t('automation.areaSearch.because', { radius: run.plan.radius });
    if (refused !== null) this.events.notice?.(refused, 'area-search');
    this.events.notice?.(t('automation.areaSearch.done', { searched, missed }), 'area-search');
    this.events.decided?.({ at: this.now(), action: ACTION, because, acted: searched > 0 });
  }

  private refuse(why: string): string {
    const sentence = t('automation.areaSearch.refused', { why });
    this.events.notice?.(sentence, 'area-search');
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

/** The rooms left out for their spell, folded per spell for the dialog. */
function hazardsOf(
  plan: AreaPlan,
  names: (rooms: readonly RoomId[]) => string[]
): Extract<AreaSearchPreview['plan'], { rooms: number }>['hazard'] {
  const bySpell = new Map<string, { items: string[]; rooms: RoomId[] }>();
  for (const { room, spell, items } of plan.hazard) {
    const seen = bySpell.get(spell) ?? { items, rooms: [] };
    seen.rooms.push(room);
    bySpell.set(spell, seen);
  }
  return [...bySpell].map(([spell, { items, rooms }]) => ({ spell, items, rooms: names(rooms) }));
}
