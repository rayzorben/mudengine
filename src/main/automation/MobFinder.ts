/**
 * Finding a monster that lairs in several rooms (the palette's *Find*, the
 * player's ask): its lair rooms in the navigation engine's order
 * (`MobFindPlan`), one walk per room, and the find over in the first room
 * the monster stands in, the walk ended there. Where the way to the next
 * room passes a lair still to see, the walk stops there first. A leg a fight
 * or a hold ended short is planned again once; a room the walk still cannot
 * reach is passed over. A run away, being attacked with auto-combat off,
 * leaving the realm, a death, the player's stop and three rooms missed in a
 * row end it. What happens once it is found is auto-combat's, as for any
 * monster met. See `mudengine-automation` › *Finding a monster walks its
 * lairs until it is seen*.
 */
import type { SessionModule } from './Module';
import { tripEndedBy, tripHeld, tripRefusal, type TripEnd, type TripRefusal } from './tripGuards';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import type { CharacterState } from '../../shared/character';
import type { NoticeSink } from '../../shared/decisionSettings';
import type { MobFindEnding, MobFindPlan, MobFindPreview } from '../../shared/mobFind';
import type { RoomId, Route } from '../../shared/world';

export interface MobFinderPlanner {
  /** Where the character stands, or null while unplaced. */
  here(): RoomId | null;
  /** A route to the room from here, or the reason there is none. */
  routeTo(room: RoomId): Route | string;
  /** Hands the route to the walker as a leg. Returns its refusal, or null. */
  walk(route: Route): string | null;
  /** Ends the walk under way: the monster is here. */
  stopWalk(reason: string): void;
  /** Turns the master switch on for the walk, as the palette's *Go to* does; its refusal, or null. */
  switchedOnFor(start: () => string | null): string | null;
  /** The monster's lair rooms from here, in walking order, or why there is no find. */
  plan(name: string): MobFindPlan | string;
  /** The room's name, as the realm states it. */
  nameOf(room: RoomId): string;
  /** Whether the monster, as the realm spells it, stands in the room the character is in. */
  present(mob: string, state: CharacterState): boolean;
  /** Auto-combat fights what attacks: on, with the master switch. */
  fightsBack(): boolean;
  moveInFlight(): boolean;
  walking(): boolean;
  looping(): boolean;
  /** Another trip has the character. */
  busy(): boolean;
  /** The character is running away. */
  escaping(): boolean;
  /** A fight here, or one auto-combat is about to open. */
  fighting(): boolean;
}

export interface MobFinderEvents {
  notice?: NoticeSink;
  decided?(decision: SafetyDecision): void;
}

interface Run {
  plan: MobFindPlan;
  /** The rooms seen, and those passed over. */
  done: Set<RoomId>;
  /** The room the walk under way is for; null between walks. */
  target: RoomId | null;
  /** The rooms whose walk ended short once, each planned again once. */
  retried: Set<RoomId>;
  missedInARow: number;
  /** Between rooms: the next walk starts when nothing holds the character. */
  between: boolean;
}

const ACTION = 'find a monster';
const DECISION = 'mob-find';

export class MobFinder implements SessionModule {
  private run: Run | null = null;

  constructor(
    private enabled: boolean,
    private readonly planner: MobFinderPlanner,
    private readonly events: MobFinderEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.finish('switched-off', t('automation.mobFind.endedSwitchedOff'));
  }

  reset(): void {
    this.run = null;
  }

  get busy(): boolean {
    return this.run !== null;
  }

  /** The walk a find of this monster would take, for the dialog, or why there is none. */
  preview(name: string): MobFindPreview {
    const plan = this.planner.plan(name);
    if (typeof plan === 'string') return { refused: plan };
    const names = (rooms: readonly RoomId[]): string[] =>
      rooms.map((room) => this.planner.nameOf(room));
    return {
      mob: plan.mob,
      regenHours: plan.regenHours,
      rooms: names(plan.rooms),
      steps: plan.steps,
      unreached: names(plan.unreached),
      combatOff: !this.planner.fightsBack()
    };
  }

  /** Starts the find; its refusal, said and traced, or null once under way. */
  start(name: string, state: CharacterState): string | null {
    const why = this.whyNot(state);
    if (why !== null) return this.refuse(name, why);
    const plan = this.planner.plan(name);
    if (typeof plan === 'string') return this.refuse(name, plan);
    // A walk the player sends the character on turns the master switch on.
    const refused = this.planner.switchedOnFor(() => this.begin(plan, state));
    return refused === null ? null : this.refuse(plan.mob, refused);
  }

  /** The player's stop, through `Travel.stopMoving`: ended before the walk's end is heard. */
  stop(reason: string): void {
    this.finish('stopped', t('automation.mobFind.endedStopped', { why: reason }));
  }

  /** A death: the lairs are somewhere else now. */
  abandon(): void {
    this.finish('died', t('automation.mobFind.endedDied'));
  }

  onCharacter(state: CharacterState): void {
    const run = this.run;
    if (run === null) return;
    const ended = tripEndedBy(this.planner, state);
    if (ended !== null) {
      this.finish(ended, this.endWords(ended));
      return;
    }
    if (this.seen(run, state) || !run.between || tripHeld(this.planner, state)) return;
    run.between = false;
    this.next(run);
  }

  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    const run = this.run;
    if (run === null || run.target === null) return;
    const room = run.target;
    run.target = null;
    if (this.seen(run, state)) return;
    if (arrived && this.planner.here() === room) this.notThere(run, room);
    // A leg a fight or a hold ended short: planned again from wherever it ended, once.
    else if (run.retried.has(room)) this.missed(run, room, reason);
    else run.retried.add(room);
    if (this.run === run) run.between = true;
  }

  private begin(plan: MobFindPlan, state: CharacterState): string | null {
    if (!this.enabled) return t('automation.mobFind.refusalSwitchedOff');
    const run: Run = {
      plan,
      done: new Set(),
      target: null,
      retried: new Set(),
      missedInARow: 0,
      between: false
    };
    this.run = run;
    this.events.notice?.(
      t('automation.mobFind.starting', {
        mob: plan.mob,
        rooms: plan.rooms.length,
        steps: plan.steps
      }),
      DECISION
    );
    if (!this.seen(run, state)) this.next(run);
    return null;
  }

  /** The monster is here: the walk ends in this room and the find is over. */
  private seen(run: Run, state: CharacterState): boolean {
    if (!this.planner.present(run.plan.mob, state)) return false;
    const here = this.planner.here();
    if (this.planner.walking()) {
      this.planner.stopWalk(t('automation.mobFind.whyStopped', { mob: run.plan.mob }));
    }
    this.finish(
      'found',
      here === null
        ? t('automation.mobFind.foundHere', { mob: run.plan.mob })
        : t('automation.mobFind.found', { mob: run.plan.mob, room: this.planner.nameOf(here) })
    );
    return true;
  }

  /** The find's words for what ended it (`tripEndedBy`). */
  private endWords(end: TripEnd): string {
    switch (end) {
      case 'left-realm':
        return t('automation.mobFind.endedLeftRealm');
      case 'ran-away':
        return t('automation.mobFind.endedRanAway');
      case 'attacked':
        return t('automation.mobFind.endedAttacked');
      default: {
        const never: never = end;
        return never;
      }
    }
  }

  private whyNot(state: CharacterState): string | null {
    const why = tripRefusal(this.planner, state, this.run !== null);
    return why === null ? null : this.refusalWords(why);
  }

  /** The find's words for why it cannot start (`tripRefusal`). */
  private refusalWords(why: TripRefusal): string {
    switch (why) {
      case 'not-in-realm':
        return t('automation.mobFind.refusalNotInRealm');
      case 'running':
        return t('automation.mobFind.refusalRunning');
      case 'fighting':
        return t('automation.mobFind.refusalFighting');
      case 'looping':
        return t('automation.mobFind.refusalLooping');
      case 'busy':
        return t('automation.mobFind.refusalBusy');
      default: {
        const never: never = why;
        return never;
      }
    }
  }

  /**
   * The walk to the next lair not yet seen. Where the way there passes a lair
   * still to see, the walk stops there first, so no lair is walked through
   * unlooked at and come back to.
   */
  private next(run: Run): void {
    // Each pass marks a room done or starts a walk, so this ends.
    while (this.run === run) {
      const room = run.plan.rooms.find((each) => !run.done.has(each));
      if (room === undefined) {
        this.finish('not-found', t('automation.mobFind.endedNotFound', { mob: run.plan.mob }));
        return;
      }
      // Standing in it already, and the monster is not here: seen.
      if (this.planner.here() === room) {
        this.notThere(run, room);
        continue;
      }
      const way = this.firstOnTheWay(run, room);
      if (way === null) {
        this.missed(run, room, null);
        continue;
      }
      const refused = this.planner.walk(way.route);
      if (refused !== null) {
        this.missed(run, way.to, refused);
        continue;
      }
      run.target = way.to;
      return;
    }
  }

  /** The way to the room, or to a lair still to see that it passes first; null with no way. */
  private firstOnTheWay(run: Run, room: RoomId): { to: RoomId; route: Route } | null {
    const route = this.planner.routeTo(room);
    if (typeof route === 'string' || route.blocked) return null;
    const lairs = new Set(run.plan.rooms);
    const first = route.steps.find((step) => lairs.has(step.to) && !run.done.has(step.to))?.to;
    if (first === undefined || first === room) return { to: room, route };
    const nearer = this.planner.routeTo(first);
    return typeof nearer === 'string' || nearer.blocked
      ? { to: room, route }
      : { to: first, route: nearer };
  }

  private notThere(run: Run, room: RoomId): void {
    run.done.add(room);
    run.missedInARow = 0;
    this.events.notice?.(
      t('automation.mobFind.notThere', {
        mob: run.plan.mob,
        room: this.planner.nameOf(room),
        done: run.done.size,
        rooms: run.plan.rooms.length
      }),
      DECISION
    );
  }

  private missed(run: Run, room: RoomId, why: string | null): void {
    run.done.add(room);
    run.missedInARow += 1;
    const place = this.planner.nameOf(room);
    this.events.notice?.(
      why === null
        ? t('automation.mobFind.missedNoWay', { room: place })
        : t('automation.mobFind.missed', { room: place, why }),
      DECISION
    );
    if (run.missedInARow >= tuning().mobFind.missedInARow) {
      this.finish('missed', t('automation.mobFind.endedMissed', { missed: run.missedInARow }));
    }
  }

  /** The find over: what came of it said and traced. */
  private finish(ending: MobFindEnding, said: string): void {
    const run = this.run;
    this.run = null;
    if (run === null) return;
    this.events.notice?.(said, DECISION);
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.mobFind.because', { mob: run.plan.mob }),
      acted: ending === 'found'
    });
  }

  private refuse(mob: string, why: string): string {
    const sentence = t('automation.mobFind.refused', { mob, why });
    this.events.notice?.(sentence, DECISION);
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.mobFind.because', { mob }),
      acted: false,
      refused: sentence
    });
    return why;
  }
}
