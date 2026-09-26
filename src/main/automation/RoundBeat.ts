/**
 * Where a round's blows begin. The server prints a round's blows together on
 * the room's tick, so blows closer than `tuning.combat.roundGapMs` are one
 * round and the first after a longer quiet opens the next. `CombatLease` counts
 * rounds with it and `CastRound` reopens the round's cast with it.
 */
import { tuning } from '../app/tuning';

export class RoundBeat {
  private lastBlowAt = Number.NEGATIVE_INFINITY;

  /** A blow, hit or miss, at `at`; true when it opens a new round. */
  blow(at: number): boolean {
    const opens = at - this.lastBlowAt > tuning().combat.roundGapMs;
    this.lastBlowAt = at;
    return opens;
  }

  reset(): void {
    this.lastBlowAt = Number.NEGATIVE_INFINITY;
  }
}
