/**
 * When a fight is too dangerous to start, to stay in, or to stay connected
 * through, read off the room's simulated fight (`simulateFight`): how often
 * the character walks out, and the most health any one round of it took.
 * One simulation answers all three:
 *
 * - Open a fight only when it is survived at least `openAbove` of the time
 *   from the health the character has now, and when the next `runRounds`
 *   worst rounds would not already have it running. A fight nobody can work
 *   out is not refused here; the run and the hang-up act on it.
 * - Run once the next `runRounds` worst rounds could take what is left. A
 *   share of maximum health is the same figure at every level; this is not:
 *   two thugs that can land 22 in a round make 10 HP of 34 a corpse.
 * - Hang up when the next `hangUpRounds` worst rounds could kill, where the
 *   realm's charge for hanging up would not kill first (`Player.Disconnects`:
 *   an unclean hang-up on a PvP realm takes `PVPHangHPHit`% of maximum
 *   health, and dies of it where that is more than is left).
 *
 * Dependency-free like everything in `shared/`.
 */
import type { Survival } from './survival';

/** `tuning.combat`'s figures for opening a fight. */
export interface DangerTuning {
  /** The share of fights survived from here that opening one needs; 0 never refuses for it. */
  openAbove: number;
  /** Run once this many worst rounds could take the health left; 0 leaves it to the share. */
  runRounds: number;
}

/**
 * Why a fight is not opened, with the health to rest to first, or null when
 * it may be. `needs` is null where resting would not change the answer: the
 * character is already at full health.
 */
export type OpeningRefusal =
  | { kind: 'odds'; survives: number; needs: number | null }
  /** Opened now, it would have to run at once. */
  | { kind: 'health'; needs: number };

/** Whether the next `count` worst rounds could take what is left; 0 never. */
export function roundsCouldKill(hp: number | null, fight: Survival | null, count: number): boolean {
  if (hp === null || fight === null || count <= 0) return false;
  const could = fight.worstRound * count;
  return could > 0 && hp <= could;
}

/** Whether to open the fight this simulation is of. */
export function openingRefusal(
  fight: Survival | null,
  hp: number | null,
  hpMax: number | null,
  tune: DangerTuning
): OpeningRefusal | null {
  if (fight === null || hp === null) return null;
  if (roundsCouldKill(hp, fight, tune.runRounds)) {
    const wanted = Math.floor(fight.worstRound * tune.runRounds) + 1;
    return { kind: 'health', needs: hpMax === null ? wanted : Math.min(hpMax, wanted) };
  }
  if (tune.openAbove > 0 && fight.survives < tune.openAbove) {
    const rested = hpMax === null || hp >= hpMax;
    return { kind: 'odds', survives: fight.survives, needs: rested ? null : hpMax };
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
