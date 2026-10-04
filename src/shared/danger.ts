/**
 * Whether a fight is survived well enough to cost a planned route nothing
 * over a plain fight: at least `openAbove` of the room's simulated fights at
 * full health. Below it the navigation engine adds to the route's cost
 * (`navigation/plan.ts`, `fightPrice`); nothing here refuses a fight.
 * Auto-combat opens by the player's rules whatever the odds, and once a fight
 * is on it is fought by them: heal, run below `safety.retreat.belowHealth`,
 * hang up below `safety.hangUp.belowHealth` (the user, 2026-10-02 and
 * 2026-10-03).
 *
 * Dependency-free like everything in `shared/`.
 */
import type { Odds } from './survival';

/**
 * Undefined where this fight is survived at least `openAbove` of the time
 * rested, else the share of it survived, or null while it is still being
 * worked out. A fight the simulator cannot run is undefined too: one unpriced
 * monster would otherwise price every route through its room.
 */
export function unfoughtShare(fight: Odds, openAbove: number): number | null | undefined {
  if (openAbove === 0 || fight.kind === 'unrun') return undefined;
  if (fight.kind !== 'run') return null;
  return fight.survival.survives < openAbove ? fight.survival.survives : undefined;
}
