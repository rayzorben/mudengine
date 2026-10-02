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
import type { Survival } from './survival';

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
  if (openAbove > 0 && fight.survives < openAbove) {
    return { kind: 'odds', survives: fight.survives, needs };
  }
  return null;
}
