/**
 * Frames the decoded stream into lines.
 *
 * This is the single most important parsing fact about this game family, and
 * both reference clients had to discover it the hard way: **line framing is not
 * CRLF.** The server rewrites its status line in place by emitting
 * `ESC[79D ESC[K` — move 79 columns left, erase to end of line — rather than a
 * newline. Splitting on CRLF alone therefore merges the prompt into whatever
 * follows and mis-frames every block after it.
 *
 * See docs/reference-codebases.md §2.4. `megamind-client` splits on CRLF and
 * then splits each result again on the repaint marker; the CoffeeScript
 * `mudengine` splits on a lookbehind so the marker stays with the *preceding*
 * line, deliberately, so that a long `who` listing can be recognised as
 * complete by its terminating marker. This implementation keeps the marker with
 * the preceding line for the same reason, and reports it explicitly rather than
 * leaving callers to sniff for it.
 *
 * The tokenizer is display-independent, and lossless: a line's text keeps its
 * terminator, so concatenating the framed lines and the pending tail gives the
 * stream back byte for byte. That is what lets the terminal be fed *lines*
 * (`TerminalFeed`) and still render the repaint as the repaint the server
 * intended. Framing lives here rather than in the quirk shims that rewrite
 * what the terminal sees.
 */
import { PROMPT_REPAINT } from './stream-quirks';
import type { LineTerminator } from '../../shared/types';
import { tuning } from '../app/tuning';

/**
 * A framed line before the session stamps it.
 *
 * `StreamLine` in `@shared/types` is this plus `seq`, `at` and `plain`; the
 * tokenizer deals only in framing and leaves identity to its caller.
 */
export interface FramedLine {
  /** The line as it arrived, ANSI sequences included. */
  text: string;
  /** What ended it. */
  terminator: LineTerminator;
}

/**
 * Incremental, allocation-light line framing over a chunked stream.
 *
 * Chunk boundaries fall anywhere, including inside a terminator, so the
 * tokenizer holds a partial line between calls. Callers must use one instance
 * per connection and `reset()` it between sessions.
 */
export class LineTokenizer {
  private pending = '';

  /**
   * Frames everything terminated within `chunk`.
   *
   * Any trailing unterminated text is retained for the next call, so a status
   * line split across two TCP segments is still recognised as one line.
   */
  push(chunk: string): FramedLine[] {
    if (chunk.length === 0) return [];

    this.pending += chunk;
    const lines: FramedLine[] = [];

    for (;;) {
      const next = this.findTerminator();
      if (!next) break;

      lines.push({
        text: this.pending.slice(0, next.end),
        terminator: next.terminator
      });
      this.pending = this.pending.slice(next.end);
    }

    if (this.pending.length > tuning().net.maxPendingBytes) {
      lines.push({ text: this.pending, terminator: 'flush' });
      this.pending = '';
    }

    return lines;
  }

  /**
   * Releases any buffered partial line.
   *
   * Call on disconnect: a prompt with no trailing newline — which is exactly
   * what the login prompt is — would otherwise never be reported at all.
   */
  flush(): FramedLine[] {
    if (this.pending.length === 0) return [];
    const line: FramedLine = { text: this.pending, terminator: 'flush' };
    this.pending = '';
    return [line];
  }

  /** Discards buffered state. Call between connections. */
  reset(): void {
    this.pending = '';
  }

  /** What is currently held back, for diagnostics. */
  get buffered(): string {
    return this.pending;
  }

  /**
   * Locates the earliest terminator in the pending buffer.
   *
   * `end` is the index one past the terminator, so the marker stays attached to
   * the line it ends — see the class comment for why that matters for the
   * repaint case.
   */
  private findTerminator(): { end: number; terminator: LineTerminator } | null {
    const newline = this.pending.indexOf('\n');
    const repaint = this.pending.indexOf(PROMPT_REPAINT);

    if (newline === -1 && repaint === -1) return null;

    const useRepaint = newline === -1 || (repaint !== -1 && repaint < newline);
    if (useRepaint) {
      return { end: repaint + PROMPT_REPAINT.length, terminator: 'repaint' };
    }

    return { end: newline + 1, terminator: 'newline' };
  }
}

/**
 * Strips ANSI escape sequences.
 *
 * CSI first, so a well-formed `ESC [ params final` is consumed whole; the
 * second alternative then catches the two-character escapes (`ESC c`, `ESC 7`)
 * and any malformed introducer, so a stray ESC can never leak into text a
 * parser rule is matched against.
 */
const ANSI = /\x1B\[[0-9;?]*[\x40-\x7E]|\x1B[\x30-\x7E]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * The plain text of a line, with its terminator and trailing CR removed.
 *
 * This is what a parser rule should match against: every pattern in both
 * reference clients is written against stripped text, with ANSI attributes
 * carried alongside as a confidence signal rather than as the test
 * (docs/legacy-assessment.md §5, consequence 3).
 */
export function plainText(line: FramedLine): string {
  return stripAnsi(line.text)
    .replace(/\r?\n$/, '')
    .replace(/\r$/, '');
}
