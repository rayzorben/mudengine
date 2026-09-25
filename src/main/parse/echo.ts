/**
 * What the realm's own echo says a line answers: one reading of it
 * (`answeringAfter`, `SessionManager.answering` and the tracker's
 * `Expectations` alike), and one pairing of a command's answer by it across
 * the lines between (`EchoSince`: `FleeGoto`, a `sys go`'s promise; todos 766,
 * 769). See `mudengine-wire` › `parts/room.md` › *A command the server
 * refused is a room that is not coming*.
 */
import type { Block } from '../../shared/blocks';
import { tailAfterPrompt } from './Classifier';

/**
 * The command a status line echoed after its colon, or null for a bare prompt.
 *
 * `[HP=334/KAI=0]:med` is the server's own statement of what it is about to
 * answer: the prompt's tail (`tailAfterPrompt`), so a `(Resting)` flag the
 * prompt pattern already consumed is never mistaken for a word somebody typed.
 */
export function echoedCommand(plain: string): string | null {
  return tailAfterPrompt(plain)?.trim() ?? null;
}

/**
 * Which command the lines after `block` answer, `before` being the one the
 * lines before it did.
 *
 * The server prints the command it is answering after the prompt —
 * `[HP=334/KAI=0]:med` — and everything up to the next prompt is that
 * command's answer. So `Your command had no effect.` is attributed to the echo
 * before it, never to the queue's bookkeeping, which counts prompts and cannot
 * tell the player's `l` from automation's `med` sent in the same breath.
 *
 * A command typed ahead of the prompt is echoed on a bare line instead —
 * `captures/009:141`: `hid` at the prompt, `bs k` on its own line, then the
 * refusal, which is the second command's. The classifier already knows an
 * echo of something this client sent, so it moves the answer along with it.
 */
export function answeringAfter(
  block: Pick<Block, 'type' | 'text'>,
  before: string | null
): string | null {
  if (block.type === 'status-line') return echoedCommand(block.text);
  if (block.type === 'command-echo') return block.text.trim();
  return before;
}

/**
 * One command sent, and the last command the realm echoed since: what pairs a
 * sentence that names nothing (`Your command had no effect.`, a `sys`
 * refusal) with the command it answers.
 */
export class EchoSince {
  /** The command as its echo spells it: trimmed, lower-cased. */
  readonly command: string;
  private last: string | null = null;

  constructor(command: string) {
    this.command = command.trim().toLowerCase();
  }

  /**
   * One block after the send, handed `answering` as it stood before it.
   *
   * A bare prompt does not clear the echo: the realm may repaint one between
   * an echo and its answer (`logs/2026-08-30_20-57-36_main.mudcap.jsonl`,
   * todo 766). And a sentence glued to a prompt reads as that prompt's echo;
   * it is the realm answering, not an echo
   * (`2026-09-19_00-44-05_vaelor2.mudcap.jsonl`).
   */
  heard(block: Pick<Block, 'text'>, answering: string | null): void {
    const echoed = answering?.trim().toLowerCase() ?? null;
    if (echoed !== null && echoed !== block.text.trim().toLowerCase()) this.last = echoed;
  }

  /** Whether the realm has echoed any command since the send. */
  get echoed(): boolean {
    return this.last !== null;
  }

  /**
   * Whether an answer read now is this command's: echoed against it, or with
   * nothing echoed since. A typed command's letters are echoed before its send
   * (`2026-09-01_14-26-16_vaelor2.mudcap.jsonl`), so its answer is often the
   * unechoed one.
   */
  get answers(): boolean {
    return this.last === null || this.last === this.command;
  }
}
