/**
 * A leader walking back for a member left behind (`@comeback`, todo
 * 20261023-1950-01): back down the trail, one room a leg (`backLeg`), to the
 * room the member was last seen in and up to `party.comebackRooms` rooms past
 * it, until the member is here; then invited, and what was stopped goes on.
 * MegaMUD walks back 5 (`Player is: Backtracking %d rooms.`). See
 * `mudengine-automation` › parts/remotes.md.
 */
import { t } from '../app/i18n';
import { backLeg, settleBack } from './trailBack';
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
  /** `party.comebackRooms`: 0 never walks back. */
  rooms(): number;
  notice: NoticeSink;
}

interface Walk {
  who: string;
  /** Legs still allowed, down to 0. */
  legsLeft: number;
  /** The leg on the way: the trail entry it walks back over, and its steps. */
  leg: { step: TrailStep; steps: number } | null;
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
    if (this.walk !== null) {
      this.port.notice(t('session.comeBack.busy', { who, busy: this.walk.who }), COMEBACK);
      return;
    }
    if (present(state, who)) {
      this.port.invite(who);
      this.port.notice(t('session.comeBack.here', { who }), COMEBACK);
      return;
    }
    const busy = this.port.busy();
    if (busy !== null) {
      this.port.notice(t('session.comeBack.notNow', { who, reason: busy }), COMEBACK);
      return;
    }
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
    const started = t('session.comeBack.started', { who, rooms: legs });
    const stopped = this.port.pause(started);
    if (!stopped) this.port.notice(started, COMEBACK);
    // Read once the route is stopped, and before the first leg back replaces it.
    this.owed = this.port.unfinished();
    this.walk = { who, legsLeft: legs, leg: null, walked: 0, due: false, stopped };
    this.next();
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
    this.port.notice(t('session.comeBack.noWay', { who: walk.who, reason: refused }), COMEBACK);
    this.finish(walk);
  }

  private found(walk: Walk): void {
    const said = t('session.comeBack.here', { who: walk.who });
    this.port.invite(walk.who);
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
   * waits on a member's word, whose `@ok` goes on with it (`PartyWait`).
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
