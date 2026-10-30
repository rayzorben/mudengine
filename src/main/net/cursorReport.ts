/**
 * The connection answers the cursor-position request (`ESC[6n`) itself (todo
 * 832, part 2). The Major BBS v10 sends one under `Auto-sensing...` and, with
 * no report back, decides the caller has no ANSI and sends the whole session
 * without colour (OCI, `logs/2026-10-30_18-45-39_soul.mudcap.jsonl`, t=64: the
 * art arrived 2s later as bare CP437 shading). The terminal swallows every
 * query (`terminalQueries.ts`) because it may be open in several windows or in
 * none, so the answer comes from here, from where this count puts the cursor.
 * Every other query is left unanswered and reported, the `ESC[!` RIP probe
 * that follows among them: this client draws no RIP graphics.
 */
import type { TerminalSize } from '../../shared/types';
import { CSI_HEAD, OSC } from './stream-quirks';

/** A query the server sent, and what the connection wrote back (`null`: nothing). */
export interface TerminalQuery {
  readonly asked: string;
  readonly answer: string | null;
}

// Sticky, read at an offset: a chunk of ANSI art holds thousands of escapes.
/** A CSI sequence, whole; `splitTrailingEscape` holds back a partial one. */
const CSI = new RegExp(`${CSI_HEAD.source}([@-~])`, 'y');
/** A CSI the server abandoned for a control byte (`ESC[!` then `\b`). */
const ABANDONED_CSI = new RegExp(CSI_HEAD.source, 'y');
/** Any other escape: an OSC to its terminator, or a two-byte one. */
const OTHER_ESCAPE = new RegExp(`${OSC.source}|\\x1B.?`, 'y');

/** `pattern` matched at `at` in `text`, or null. */
function matchAt(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

/** The queries a terminal would answer and this connection does not. */
function isQuery(intermediates: string, final: string): boolean {
  if (final === 'n' || final === 'c') return true;
  return final === 'p' && intermediates === '$';
}

export class CursorReport {
  private row = 1;
  /** One past the last column after printing there: the wrap waits for the next glyph, as in xterm. */
  private col = 1;
  private saved = { row: 1, col: 1 };

  constructor(private readonly size: () => TerminalSize) {}

  /** Follows `text` (decoded, whole escapes, as painted) and returns the queries in it, in order. */
  feed(text: string): TerminalQuery[] {
    const queries: TerminalQuery[] = [];
    let i = 0;
    while (i < text.length) {
      const ch = text.charAt(i);
      if (ch === '\x1b') {
        const csi = matchAt(CSI, text, i);
        if (csi !== null) {
          const [sequence, params = '', intermediates = '', final = ''] = csi;
          const query = this.csi(sequence, params, intermediates, final);
          if (query !== null) queries.push(query);
          i += csi[0].length;
          continue;
        }
        const abandoned = matchAt(ABANDONED_CSI, text, i);
        if (abandoned !== null) {
          queries.push({ asked: abandoned[0], answer: null });
          i += abandoned[0].length;
          continue;
        }
        const other = matchAt(OTHER_ESCAPE, text, i)?.[0] ?? ch;
        if (other === '\x1b7') this.saved = { row: this.row, col: this.col };
        if (other === '\x1b8') ({ row: this.row, col: this.col } = this.saved);
        i += other.length;
        continue;
      }
      this.character(ch);
      i += 1;
    }
    return queries;
  }

  private character(ch: string): void {
    const { cols, rows } = this.size();
    if (ch === '\r') this.col = 1;
    else if (ch === '\n' || ch === '\v' || ch === '\f') this.row = Math.min(rows, this.row + 1);
    else if (ch === '\b') this.col = Math.max(1, Math.min(cols, this.col) - 1);
    else if (ch === '\t') this.col = Math.min(cols, Math.floor((this.col - 1) / 8) * 8 + 9);
    else if (ch >= ' ' && ch !== '\x7f') {
      if (this.col > cols) {
        this.col = 1;
        this.row = Math.min(rows, this.row + 1);
      }
      this.col += 1;
    }
  }

  private csi(
    sequence: string,
    params: string,
    intermediates: string,
    final: string
  ): TerminalQuery | null {
    const { cols, rows } = this.size();
    if (final === 'n' && params === '6' && intermediates === '') {
      // Both clamped: a resize since the last move may have shrunk the screen under the cursor.
      return {
        asked: sequence,
        answer: `\x1b[${Math.min(rows, this.row)};${Math.min(cols, this.col)}R`
      };
    }
    if (isQuery(intermediates, final)) return { asked: sequence, answer: null };
    if (params.startsWith('?') || intermediates !== '') return null;

    const args = params.split(';').map((p) => Number.parseInt(p, 10));
    const n = (index: number): number => {
      const arg = args[index] ?? Number.NaN;
      return Number.isNaN(arg) ? 1 : Math.max(1, arg);
    };
    const clampRow = (row: number): number => Math.min(rows, Math.max(1, row));
    const clampCol = (col: number): number => Math.min(cols, Math.max(1, col));
    switch (final) {
      case 'H':
      case 'f':
        this.row = clampRow(n(0));
        this.col = clampCol(n(1));
        break;
      case 'A':
        this.row = clampRow(this.row - n(0));
        break;
      case 'B':
        this.row = clampRow(this.row + n(0));
        break;
      case 'C':
        this.col = clampCol(Math.min(cols, this.col) + n(0));
        break;
      case 'D':
        this.col = clampCol(Math.min(cols, this.col) - n(0));
        break;
      case 'G':
        this.col = clampCol(n(0));
        break;
      case 'd':
        this.row = clampRow(n(0));
        break;
      case 's':
        this.saved = { row: this.row, col: this.col };
        break;
      case 'u':
        ({ row: this.row, col: this.col } = this.saved);
        break;
    }
    return null;
  }
}
