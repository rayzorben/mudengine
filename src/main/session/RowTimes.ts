/**
 * Which console rows carry a time: the status line's, and no other (todo 27).
 *
 * The feed tells this what each piece of painted text is as it appends it,
 * and this answers what goes in front of it. A status line gets a time on a
 * row that has none; the realm's repaint of it (`ESC[79D ESC[K` and the same
 * prompt) keeps the time the row was first drawn. A command's echo on the
 * prompt row moves it to the moment the command went out. Paradigm
 * (paramud.mudinfo.net) erases the prompt row and writes the next line over
 * it, so text over an erased timed row takes the time off.
 * `mudengine-session` › *A status line's time rides in the painted text*.
 */
import { stripAnsi } from '../net/LineTokenizer';
import { PROMPT_REPAINT } from '../net/stream-quirks';
import type { RowTime } from '../../shared/stamps';

/**
 * What a piece of painted text is, as far as the row's time goes: a status
 * line, one with a command's echo on it (`[HP=34]:n`), a command's echo
 * framed alone after the prompt, or anything else.
 */
export type RowText = 'status' | 'status-echo' | 'echo' | 'other';

export class RowTimes {
  /** The row the cursor is on has a time. */
  private timed = false;
  /** The repaint has erased that row since, so what is written next replaces it. */
  private erased = false;

  /** What goes in front of `text`, written on the cursor's row, and the row as `text` leaves it. */
  before(text: string, kind: RowText): RowTime | null {
    const put = this.put(text, kind);
    if (put === 'time') this.timed = true;
    if (put === 'clear') this.timed = false;
    if (put !== null || visible(text)) this.erased = false;
    const end = text.lastIndexOf('\n');
    if (end !== -1) {
      this.timed = false;
      this.erased = false;
    }
    if (text.includes(PROMPT_REPAINT, end + 1)) this.erased = this.timed;
    return put;
  }

  /** A new connection: the console's next row is a fresh one. */
  reset(): void {
    this.timed = false;
    this.erased = false;
  }

  private put(text: string, kind: RowText): RowTime | null {
    switch (kind) {
      case 'status-echo':
        return 'time';
      case 'status':
        return this.timed ? null : 'time';
      case 'echo':
        // Only on the standing prompt row: an echo on a row of its own gets no time.
        if (this.timed && !this.erased) return 'time';
        return this.put(text, 'other');
      case 'other':
        return this.timed && this.erased && visible(text) ? 'clear' : null;
      default: {
        const never: never = kind;
        throw new Error(`unknown row text ${String(never)}`);
      }
    }
  }
}

/** Whether `text` writes anything to the row it starts on. */
function visible(text: string): boolean {
  const row = text.split('\n', 1)[0] ?? '';
  return stripAnsi(row).replace(/\r/g, '').length > 0;
}
