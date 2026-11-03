/**
 * Auto-Sneak on Move for the player's own moves (the user, 2026-11-02: "auto
 * sneak is auto sneak"): a key or a typed line that moves the character gets
 * an `sn` ahead of each move, which `MacroRunner` sends and waits on as it
 * does a `{sneak}`. Unlike `{sneak}`, a refusal does not drop the move: the
 * player asked to go there, so it asks again until the refusals in a row
 * reach `movement.sneakGiveUp` (`SneakRefusals`, the walk's count too) and
 * then steps. `mudengine-automation` › `parts/walking.md`.
 */
import type { MacroStep } from '../../shared/macroSteps';
import { MOVE_COMMANDS } from '../parse/expectations';

/** The `sn` ahead of one move. */
export interface MoveSneak {
  kind: 'move-sneak';
}

export type RunStep = MacroStep | MoveSneak;

/** Whether a step sends one of the ten directions. */
function movesOnce(step: MacroStep): step is Extract<MacroStep, { kind: 'send' }> {
  return step.kind === 'send' && Object.hasOwn(MOVE_COMMANDS, step.command.trim().toLowerCase());
}

/** Whether any step is a move, so a line with none goes as it always has. */
export function anyMove(steps: readonly MacroStep[]): boolean {
  return steps.some(movesOnce);
}

/** The steps with a `move-sneak` ahead of every move; `e` three times is three moves. */
export function sneakBeforeMoves(steps: readonly MacroStep[]): RunStep[] {
  return steps.flatMap((step): RunStep[] => {
    if (!movesOnce(step)) return [step];
    const one = { ...step, times: 1 };
    return Array.from({ length: step.times }, (): RunStep[] => [
      { kind: 'move-sneak' },
      one
    ]).flat();
  });
}
