/**
 * Whether an experience line is a kill, for the tally's count (todo 57).
 *
 * In a fight it is. MajorMUD also prints `*Combat Off*` after each kill of an
 * area spell, with the next kill's experience behind it and no prompt between
 * (captures/069, captures/081), so a run of kills stays a run until a prompt.
 * Experience after the prompt with no fight on, a hand-in, is not a kill.
 */
import { isPrompt, type Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';

export class KillRun {
  /** Whether the last experience line was a kill and no prompt has come since. */
  private open = false;

  /** Whether `block`, read against the state before it, is an experience line paid for a kill. */
  paid(block: Block, before: CharacterState): boolean {
    if (isPrompt(block.type)) this.open = false;
    if (block.type !== 'user-gain-experience') return false;
    this.open = before.inCombat || this.open;
    return this.open;
  }
}
