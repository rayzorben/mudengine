/**
 * Presentation shims for quirks of the MajorMUD-era server stream.
 *
 * These are deliberately isolated from the Telnet layer and from the parser:
 * they exist only so the terminal renders the way a 1990s DOS terminal did.
 * Each one is salvaged from `megamind-client`, where it was discovered the hard
 * way, and each is documented with the symptom it cures.
 */

import { tuning } from '../app/tuning';

export interface QuirkOptions {
  /**
   * Reproduce DOS terminal behaviour on clear-screen.
   *
   * MajorMUD emits a bare `ESC[2J` with no cursor-home for screens like
   * "train stats". Real terminals had already scrolled prior content away, so
   * the new screen appeared at the top. xterm.js instead clears in place and
   * leaves the cursor wherever it was, so the screen renders vertically
   * misaligned. Injecting a screenful of newlines before the clear, then homing
   * the cursor after it, reproduces the original layout.
   */
  preScrollOnClear: boolean;
}

export const DEFAULT_QUIRKS: QuirkOptions = {
  preScrollOnClear: true
};

/**
 * The in-place prompt repaint sequence, as a literal.
 *
 * The server rewrites its status line by emitting this — move 79 columns left,
 * erase to end of line — rather than a newline. That is a *framing* fact, not a
 * display one: the terminal must keep rendering it as the in-place repaint the
 * server intended, while the parser needs it treated as a line break. It is
 * therefore consumed by `LineTokenizer`, not rewritten here.
 *
 * An earlier `splitPromptRepaint` option lived in this file, defaulted to true,
 * and was never read by `applyQuirks`. It has been removed rather than
 * implemented: rewriting the stream for the terminal's benefit would have been
 * the wrong fix.
 */
export const PROMPT_REPAINT = '\x1B[79D\x1B[K';

const CLEAR_SCREEN = /\x1B\[2J/g;
const PRE_SCROLL = '\n'.repeat(40);

/**
 * Rewrites decoded terminal text according to the enabled quirks.
 *
 * Purely a function of its input, so the caller owns all buffering.
 */
export function applyQuirks(text: string, quirks: QuirkOptions): string {
  if (!quirks.preScrollOnClear) return text;
  // `ESC[H` after the clear homes the cursor, which the server omits.
  return text.replace(CLEAR_SCREEN, `${PRE_SCROLL}\x1B[2J\x1B[H`);
}

/**
 * Splits a trailing, incomplete ANSI escape sequence off the end of a chunk.
 *
 * The socket hands us arbitrary fragments, and a sequence split across two
 * chunks would otherwise defeat {@link applyQuirks} and any line tokenizer that
 * strips ANSI. Returns the text safe to emit now plus the fragment to prepend
 * to the next chunk.
 */
export function splitTrailingEscape(text: string): { emit: string; hold: string } {
  const start = text.lastIndexOf('\x1B');
  if (start === -1) return { emit: text, hold: '' };

  const tail = text.slice(start);
  if (tail.length > tuning().net.maxPartialEscapeBytes) return { emit: text, hold: '' };

  // A complete CSI sequence ends with a byte in the range 0x40-0x7E.
  if (/^\x1B\[[0-9;?]*[\x40-\x7E]/.test(tail)) return { emit: text, hold: '' };
  // A complete two-character escape (e.g. ESC c, ESC 7) is also finished.
  if (/^\x1B[^[\]]/.test(tail)) return { emit: text, hold: '' };
  // OSC sequences terminate with BEL or ST.
  if (/^\x1B\][^\x07\x1B]*(\x07|\x1B\\)/.test(tail)) return { emit: text, hold: '' };

  return { emit: text.slice(0, start), hold: tail };
}
