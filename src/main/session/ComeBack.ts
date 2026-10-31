/**
 * A leader walking back for a member left behind (`@comeback`, todo
 * 20261023-1950-01): back down the trail, one room a leg (`backLeg`), to the
 * room the member was last seen in and up to `party.comebackRooms` rooms past
 * it, until the member is here; then invited, and what was stopped goes on.
 * MegaMUD walks back 5 (`Player is: Backtracking %d rooms.`). `@comeback-room`
 * states the room, so it is one leg there and the same invite and resume. See
 * `mudengine-automation` › parts/remotes.md.
 */
import { t } from '../app/i18n';
import { backLeg, planned, settleBack } from './trailBack';
import { standingHere, type CharacterState } from '../../shared/character';
import type { NoticeSink } from '../../shared/decisionSettings';
import type { UnfinishedRoute } from '../../shared/walk';
import { roomAddress, type RoomId, type Route, type TrailStep } from '../../shared/world';

const COMEBACK = 'party-comeback';

export interface ComeBackPort {
  /** The moves walked, oldest first (`CharacterTracker.trail`). */
  trail(): readonly TrailStep[];
  /** The character walked back over `step`: give it up and what came after. */
  retraced(step: TrailStep): void;
  /** Where `who` was last seen in `Also here:` (`PlayerRecord.lastRoom`). */
  lastSeen(who: string): RoomId | null;
  /** A route from here to `to`, or why there is none. */
  plan(to: RoomId): Route | string;
  /** Walk a leg back, as nobody's asked route; the refusal, or null once it started. */
  walk(route: Route): string | null;
  /** Stop the leg back on the way, saying why. */
  stopWalk(why: string): void;
  /** Why a walk back cannot start now (an errand's walk, a back press), or null. */
  busy(): string | null;
  /** Stop whatever is moving, said as `why`; false where nothing was. */
  pause(why: string): boolean;
  /** The route the walker holds stopped, before a leg back replaces it. */
  unfinished(): UnfinishedRoute | null;
  /** Go on with what was stopped for `who`, the steps walked back agreed to. */
  resume(who: string, walkedBack: number): void;
  /** Whether the party still waits on somebody's word (`PartyWait`). */
  partyWaiting(): boolean;
  invite(who: string): void;
  /** Hold what was stopped until `who` joins the party again (`PartyWait`). */
  awaitJoin(who: string): void;
  /** `party.comebackRooms`: 0 never walks back. */
  rooms(): number;
  notice: NoticeSink;
}

interface Walk {
  who: string;
  /** Legs still allowed, down to 0. */
  legsLeft: number;
  /**
   * The leg on the way, and its steps: the trail entry it walks back over, or
   * null for the one leg to the room `@comeback-room` stated, which leaves the
   * trail alone.
   */
  leg: { step: TrailStep | null; steps: number } | null;
  /** Steps walked back so far, agreed to on the resume. */
  walked: number;
  /** A leg ended on arrival and the next goes on the next state. */
  due: boolean;
  /** Whether this walk back stopped something, so its end goes on with it. */
  stopped: boolean;
}

export class ComeBack {
  private walk: Walk | null = null;
  /** The route stopped for a walk back, until it is gone on with or another stop replaces it. */
  private owed: UnfinishedRoute | null = null;

  constructor(private readonly port: ComeBackPort) {}

  /** Walking back now. */
  get active(): boolean {
    return this.walk !== null;
  }

  /** A route a walk back stopped, still to go on with. */
  get owes(): boolean {
    return this.owed !== null;
  }

  /** The owed route, handed to the resume once. */
  takeOwed(): UnfinishedRoute | null {
    const owed = this.owed;
    this.owed = null;
    return owed;
  }

  /** Something else moved or stopped since: the owed route is not what goes on any more. */
  forgetOwed(): void {
    if (this.walk === null) this.owed = null;
  }

  /** `who` said `@comeback`. */
  asked(who: string, state: CharacterState): void {
    const rooms = this.port.rooms();
    if (rooms <= 0) {
      this.port.notice(t('session.comeBack.off', { who }), COMEBACK);
      return;
    }
    if (this.answered(who, state) !== null) return;
    const legs = legsBack(
      this.port.trail(),
      this.port.lastSeen(who),
      roomAddress(state.room),
      rooms
    );
    if (legs === 0) {
      this.port.notice(t('session.comeBack.nothingBehind', { who }), COMEBACK);
      return;
    }
    this.stop(who, legs, t('session.comeBack.started', { who, rooms: legs }));
    this.next();
  }

  /**
   * `who` said `@comeback-room` from `to`: one leg there, then the member is
   * invited and what was stopped goes on, as for `@comeback`. Whether this
   * character is coming or already with them, which is what `{ok}` answers.
   */
  askedTo(who: string, to: RoomId, state: CharacterState): boolean {
    const answered = this.answered(who, state);
    if (answered !== null) return answered;
    const leg = planned(this.port.plan(to));
    if (leg.kind === 'refused') return this.noWay(who, leg.reason);
    if (leg.kind === 'there') {
      return this.noWay(who, t('session.comeBack.notThere', { who, address: to }));
    }
    const { route } = leg;
    const steps = route.steps.length;
    this.stop(who, 1, t('session.comeBack.startedTo', { who, address: to, stepCount: steps }));
    const walk = this.walk;
    const notWalked = this.port.walk(route);
    // Cancelled while the leg started: nothing is coming.
    if (walk === null || this.walk !== walk) return false;
    if (notWalked === null) {
      walk.leg = { step: null, steps };
      return true;
    }
    this.noWay(who, notWalked);
    this.finish(walk);
    return false;
  }

  /** Says why there is no walk back for `who`. */
  private noWay(who: string, reason: string): false {
    this.port.notice(t('session.comeBack.noWay', { who, reason }), COMEBACK);
    return false;
  }

  /**
   * What a come-back asked of this character is answered with before any
   * walk: true where it is already walking for `who` or `who` is here
   * (invited), false where it cannot walk now (said), null to walk.
   */
  private answered(who: string, state: CharacterState): boolean | null {
    if (this.walk?.who.toLowerCase() === who.toLowerCase()) return true;
    if (this.walk !== null) {
      this.port.notice(t('session.comeBack.busy', { who, busy: this.walk.who }), COMEBACK);
      return false;
    }
    if (present(state, who)) {
      this.port.invite(who);
      this.port.notice(t('session.comeBack.here', { who }), COMEBACK);
      return true;
    }
    const busy = this.port.busy();
    if (busy === null) return null;
    this.port.notice(t('session.comeBack.notNow', { who, reason: busy }), COMEBACK);
    return false;
  }

  /** Stops what moves for a walk back of `legs` legs, saying `started`. */
  private stop(who: string, legs: number, started: string): void {
    const paused = this.port.pause(started);
    if (!paused) this.port.notice(started, COMEBACK);
    // A lap stopped for a member's @wait is this walk's stop too: if that wait gives up first, the walk's end goes on.
    const stopped = paused || this.port.partyWaiting();
    // Read once the route is stopped, and before the first leg back replaces it.
    this.owed = this.port.unfinished();
    this.walk = { who, legsLeft: legs, leg: null, walked: 0, due: false, stopped };
  }

  /** Every state: the member walking into the room ends it, and the next leg goes. */
  onCharacter(state: CharacterState): void {
    const walk = this.walk;
    if (walk === null) return;
    if (present(state, walk.who)) {
      this.found(walk);
      return;
    }
    if (walk.due) {
      walk.due = false;
      this.next();
    }
  }

  /** A walk ended (`Travel.walkEnded`): a leg back arrived, or did not. */
  walkEnded(arrived: boolean, state: CharacterState): void {
    const walk = this.walk;
    const leg = walk?.leg ?? null;
    if (walk === null || leg === null) return;
    walk.leg = null;
    if (leg.step === null) {
      this.landed(walk, leg.steps, arrived, state);
      return;
    }
    const back = settleBack(leg.step, arrived, roomAddress(state.room), (step) =>
      this.port.retraced(step)
    );
    if (!back) {
      this.port.notice(t('session.comeBack.cutShort', { who: walk.who }), COMEBACK);
      this.finish(walk);
      return;
    }
    walk.walked += leg.steps;
    walk.legsLeft -= 1;
    if (present(state, walk.who)) this.found(walk);
    // The next leg on the next state, after every module has heard this walk end.
    else walk.due = true;
  }

  /** The leg to a stated room ended: the member here is found, and otherwise the walk is over. */
  private landed(walk: Walk, steps: number, arrived: boolean, state: CharacterState): void {
    walk.walked += steps;
    if (present(state, walk.who)) {
      this.found(walk);
      return;
    }
    this.port.notice(
      arrived
        ? t('session.comeBack.notFound', { who: walk.who })
        : t('session.comeBack.cutShort', { who: walk.who }),
      COMEBACK
    );
    this.finish(walk);
  }

  /**
   * The player stopped, a death moved the character or the session ended:
   * nothing goes on, and whoever cancels stops the walker.
   */
  cancel(said: string | null): void {
    const walk = this.walk;
    this.walk = null;
    this.owed = null;
    if (walk === null || said === null) return;
    this.port.notice(t('session.comeBack.stopped', { who: walk.who, reason: said }), COMEBACK);
  }

  private next(): void {
    const walk = this.walk;
    if (walk === null) return;
    if (walk.legsLeft <= 0) {
      this.port.notice(t('session.comeBack.gaveUp', { who: walk.who }), COMEBACK);
      this.finish(walk);
      return;
    }
    const leg = backLeg(this.port.trail(), (to) => this.port.plan(to));
    if (leg.kind === 'there') {
      this.port.retraced(leg.step);
      walk.legsLeft -= 1;
      this.next();
      return;
    }
    let refused: string;
    if (leg.kind === 'walk') {
      const notWalked = this.port.walk(leg.route);
      if (notWalked === null) {
        walk.leg = { step: leg.step, steps: leg.route.steps.length };
        return;
      }
      refused = notWalked;
    } else {
      refused = leg.kind === 'refused' ? leg.reason : t('session.comeBack.trailEnded');
    }
    this.noWay(walk.who, refused);
    this.finish(walk);
  }

  private found(walk: Walk): void {
    const said = t('session.comeBack.here', { who: walk.who });
    this.port.invite(walk.who);
    // Before the walk is over, so the stop it holds is the party's to end.
    if (walk.stopped) this.port.awaitJoin(walk.who);
    if (walk.leg === null) this.port.notice(said, COMEBACK);
    else {
      // The walker says why it stopped, which is this sentence.
      walk.leg = null;
      this.port.stopWalk(said);
    }
    this.finish(walk);
  }

  /**
   * The walk back is over. What it stopped goes on, unless the party still
   * waits on a member's word or their joining, which goes on with it (`PartyWait`).
   */
  private finish(walk: Walk): void {
    this.walk = null;
    if (this.port.partyWaiting()) return;
    if (walk.stopped) {
      this.port.resume(walk.who, walk.walked);
      return;
    }
    this.owed = null;
  }
}

/**
 * How many legs back the walk may go: to the newest trail entry leaving the
 * room `who` was last seen in, then `rooms` more; `rooms` alone where that
 * room is not on the trail; never more than the trail holds.
 */
export function legsBack(
  trail: readonly TrailStep[],
  lastSeen: RoomId | null,
  from: RoomId | null,
  rooms: number
): number {
  let reach = 0;
  if (lastSeen !== null && lastSeen !== from) {
    for (let index = trail.length - 1; index >= 0; index -= 1) {
      if (trail[index]?.from === lastSeen) {
        reach = trail.length - index;
        break;
      }
    }
  }
  return Math.min(trail.length, reach + rooms);
}

function present(state: CharacterState, who: string): boolean {
  return standingHere(state).has(who.toLowerCase());
}
