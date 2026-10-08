/**
 * What the character was doing, kept in its own record so a quit and a
 * relaunch pick it up the way a dropped connection does (todo 01,
 * 2026-09-30): the lap, the route the player asked for and auto-combat a run
 * turned off, written whenever either publishes and handed back at the next
 * dial, where `Travel.pickUpAfterLoss` walks on once the character is placed. See
 * `mudengine-session` › *Every close carries the loop and the route*.
 */
import type { LoopRunner } from '../automation/LoopRunner';
import type { Travel } from './Travel';
import { NOTHING_UNDERWAY, type Underway, type UnderwaySink } from '../../shared/underway';

export class CarryOver {
  /**
   * What the record said at the start of a dial, until `takeUp` hands it on.
   * Writing stands down meanwhile: `connect` resets the runner, which
   * publishes an idle lap, and that would overwrite the record it is about to read.
   */
  private owed: Underway | null = null;
  /** Set at disposal: the record is closed at quit before the sessions go. */
  private done = false;

  constructor(
    private readonly loops: Pick<LoopRunner, 'place' | 'carry'>,
    private readonly travel: Pick<
      Travel,
      'owed' | 'owe' | 'combatOffForRunNow' | 'combatBackAfterLaunch'
    >,
    /** The record for the realm being dialled, as `SessionManager.useRealm` keeps it. */
    private readonly record: () => UnderwaySink
  ) {}

  /** At the top of `connect`, before anything is reset. */
  dial(): void {
    this.owed = this.record().recallUnderway();
  }

  /** At `connect`, once the session has put down what it does not carry. */
  takeUp(): void {
    const owed = this.owed ?? NOTHING_UNDERWAY;
    this.owed = null;
    if (owed.combatOffForRun) this.travel.combatBackAfterLaunch();
    if (owed.route !== null) this.travel.owe(owed.route);
    if (owed.lap !== null) this.loops.carry(owed.lap);
    this.remember();
  }

  /** The lap or the walk published: what is underway now. The record writes only a change. */
  remember(): void {
    if (this.owed !== null || this.done) return;
    this.record().rememberUnderway({
      lap: this.loops.place,
      route: this.travel.owed,
      combatOffForRun: this.travel.combatOffForRunNow
    });
  }

  /**
   * The session is about to dial another realm, whose record replaces `left`.
   * `connect` puts that realm's lap and route down, so its record says so.
   */
  leave(left: UnderwaySink): void {
    left.rememberUnderway(NOTHING_UNDERWAY);
  }

  dispose(): void {
    this.done = true;
  }
}
