/**
 * Whether a fight is too dangerous to start, read off the room's simulated
 * fight (`simulateFight`) from the health the character has now: opened only
 * when it is survived at least `openAbove` of the time. A fight nobody can
 * work out is not refused here.
 *
 * Nothing here runs or hangs up. Once a fight is on, the character fights it
 * by the player's rules: heal, run below `safety.retreat.belowHealth`, hang
 * up below `safety.hangUp.belowHealth` (the user, 2026-10-02: a fight is
 * tried, never given up on a prediction).
 *
 * Dependency-free like everything in `shared/`.
 */
import type { Odds, Survival } from './survival';

/**
 * Why a fight is not opened, with the health to rest to first, or null when
 * it may be. `needs` is null where resting would not change the answer: the
 * character is already at full health.
 */
export type OpeningRefusal = { kind: 'odds'; survives: number; needs: number | null };

/** Whether to open the fight this simulation is of; `openAbove` 0 never refuses. */
export function openingRefusal(
  fight: Survival | null,
  hp: number | null,
  hpMax: number | null,
  openAbove: number
): OpeningRefusal | null {
  if (fight === null || hp === null) return null;
  const needs = hpMax === null || hp >= hpMax ? null : hpMax;
  return refusedRested(fight, openAbove) ? { kind: 'odds', survives: fight.survives, needs } : null;
}

/** Whether this fight is refused even at full health: resting first would not open it. */
export function refusedRested(fight: Survival, openAbove: number): boolean {
  return openAbove > 0 && fight.survives < openAbove;
}

/**
 * Undefined where combat opens on this fight rested, else the share of it
 * survived, or null while it is still being worked out: an unknown fight is
 * not one to walk somewhere and wait for. A fight the simulator cannot run is
 * left to combat, which opens on it (`openingRefusal`).
 */
export function unfoughtShare(fight: Odds, openAbove: number): number | null | undefined {
  if (openAbove === 0 || fight.kind === 'unrun') return undefined;
  if (fight.kind !== 'run') return null;
  return refusedRested(fight.survival, openAbove) ? fight.survival.survives : undefined;
}
