/**
 * The Re-equip Gear button's work: the remembered gear's plan, each command
 * handed to the caller's way of sending it, and the notices saying what the
 * plan could not do. One unit for the button, `@equip-all` and a recovered
 * corpse (todo 39), so the three put the gear on and report it alike.
 */
import type { CharacterState } from '../../shared/character';
import { restorePlan } from '../../shared/gear';
import { tuning } from '../app/tuning';
import { restoreNotices } from './gearNotices';

export interface Restored {
  /** How many commands went to `send`. */
  sent: number;
  /** What the pack no longer holds, the cap, or that nothing was off. */
  notices: string[];
}

export function restoreKit(state: CharacterState, send: (command: string) => void): Restored {
  const plan = restorePlan(state.loadout, state.inventory.items, tuning().spending.maxGear);
  for (const command of plan.commands) send(command);
  return { sent: plan.commands.length, notices: restoreNotices(plan, state.loadout) };
}
