/**
 * The `? exp` table owed once the next level is paid for (the user, 2026-11-27).
 *
 * `exp` prices only the next level, and `STALE_AFTER` asks for the table on a
 * level or a train. A character that goes on hunting with a level ready to
 * train had no figure for the level after, so *Exp. needed* and *Will level
 * in* were blank until the player typed `? exp`. Once for each level the
 * character stands at, so a realm that prints no table is asked once.
 */
import { pricedLevelsPaid, type ExperienceProgress } from '../../shared/experience';

export class PaidLevels {
  /** The level the character stood at when the table was last owed. */
  private owedAt: number | null = null;

  /** Whether the table is owed now; true once for each level stood at. */
  owes(progress: ExperienceProgress): boolean {
    if (progress.level === this.owedAt || !pricedLevelsPaid(progress)) return false;
    this.owedAt = progress.level;
    return true;
  }

  reset(): void {
    this.owedAt = null;
  }
}
