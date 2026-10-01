/**
 * When a fight is too dangerous to start, to stay in, or to stay connected
 * through, read off the room's simulated fight (`simulateFight`) from the
 * health the character has now:
 *
 * - Open a fight only when it is survived at least `openAbove` of the time,
 *   and when it would not already have the character running. A fight nobody
 *   can work out is not refused here; the run and the hang-up act on it.
 * - Run once the share of fights the character is dead in within `runRounds`
 *   rounds is over `runRisk`. The worst round doubled was tried first: a cave
 *   bear's worst blow is 18, so a 34-HP character at full health ran from one
 *   that had missed.
 * - Hang up when the next round kills more than `hangUpRisk` of the time,
 *   where the realm's charge for hanging up would not kill first (`Player.Disconnects`:
 *   an unclean hang-up on a PvP realm takes `PVPHangHPHit`% of maximum
 *   health, and dies of it where that is more than is left).
 *
 * Dependency-free like everything in `shared/`.
 */
import type { Survival } from './survival';

/** `tuning.combat`'s figures for opening a fight and running from one. */
export interface DangerTuning {
  /** The share of fights survived from here that opening one needs; 0 never refuses for it. */
  openAbove: number;
  /** The rounds the run looks ahead over. */
  runRounds: number;
  /** The share of fights dead within `runRounds` that runs; 0 never runs for it. */
  runRisk: number;
}

/**
 * Why a fight is not opened, with the health to rest to first, or null when
 * it may be. `needs` is null where resting would not change the answer: the
 * character is already at full health.
 */
export type OpeningRefusal =
  | { kind: 'odds'; survives: number; needs: number | null }
  /** Opened now, it would have to run at once. */
  | { kind: 'risk'; risk: number; needs: number | null };

/**
 * The share of fights the character is dead in by `rounds` rounds from now,
 * read at the first horizon the simulation kept at or past it; null where it
 * kept none.
 */
export function deathRisk(fight: Survival | null, rounds: number): number | null {
  const at = fight?.horizons.find((horizon) => horizon.rounds >= rounds);
  return at === undefined ? null : 1 - at.standing;
}

/** The death risk that makes the run due (dead too often within `runRounds`), or null. */
export function runDue(
  fight: Survival | null,
  tune: Pick<DangerTuning, 'runRounds' | 'runRisk'>
): number | null {
  if (tune.runRisk <= 0) return null;
  const risk = deathRisk(fight, tune.runRounds);
  return risk !== null && risk > tune.runRisk ? risk : null;
}

/** Whether to open the fight this simulation is of. */
export function openingRefusal(
  fight: Survival | null,
  hp: number | null,
  hpMax: number | null,
  tune: DangerTuning
): OpeningRefusal | null {
  if (fight === null || hp === null) return null;
  const needs = hpMax === null || hp >= hpMax ? null : hpMax;
  const risk = runDue(fight, tune);
  if (risk !== null) return { kind: 'risk', risk, needs };
  if (tune.openAbove > 0 && fight.survives < tune.openAbove) {
    return { kind: 'odds', survives: fight.survives, needs };
  }
  return null;
}

/**
 * What hanging up now would cost in hit points: the realm's charge where it
 * charges and the hang-up would be unclean, else nothing. Null is a charge
 * nobody has stated.
 */
export function hangUpCost(hpMax: number | null, percent: number | null): number | null {
  if (percent === null) return null;
  if (hpMax === null || percent <= 0) return 0;
  return Math.ceil((percent * hpMax) / 100);
}
