/**
 * Keys drawn before the realm echoes them, and the echo taken out when it
 * comes (todo 20261104-1915-01). Every realm this client plays echoes one key
 * at a time and erases with `\b \b`, so each key's echo is known before it
 * arrives; a hosted client pays the browser's round trip for it.
 *
 * A key is drawn only at a prompt (`StreamChunk.prompt`) and only while the
 * realm's echo has matched every key drawn so far. The first byte that does
 * not match (a repaint, a `*` at a password, an echo cut from a quiet
 * command, a take-back's erase) takes back what was drawn and lets the
 * chunk paint as sent, which is what the console drew before this existed.
 * Main still sends and reads every byte as before. Pure: the clock and the
 * console belong to the caller. `mudengine-ui` › *A key is drawn before its echo, only at a prompt*.
 */
import { stampEndAt, unstamped } from '@shared/stamps';
import { withoutSgr } from '@shared/template';

/** One key drawn ahead of its echo: the bytes the realm will send for it, and the bytes that undo the drawing. */
interface Guess {
  readonly echo: string;
  readonly undo: string;
  readonly at: number;
}

/** The performance-timeline name of one key's round trip, drawn to echoed (`lib/tabHealth.ts` reads it). */
export const ECHO_MEASURE = 'mudengine.echo';

const ERASE = '\b \b';
const PRINTABLE = /^[\x20-\x7e]$/;
const ENTER = /[\r\n]/;

export class LocalEcho {
  /** `heard` is told when each drawn key's echo has come back whole, with the time it was drawn. */
  constructor(private readonly heard: (drawnAt: number) => void = () => {}) {}

  private guesses: Guess[] = [];
  /** How far into the first guess's echo the realm has written. */
  private matched = 0;
  /** The cursor is where the realm will echo the next key: set by a prompt, cleared by Enter or unasked output. */
  private atInput = false;
  /** What the realm holds of the line being typed, or null once something this did not type may have changed it. */
  private line: string | null = '';

  /** A key or run the player produced and is about to send: what to draw now, or `''`. */
  typed(data: string, now: number): string {
    if (ENTER.test(data)) {
      this.atInput = false;
      this.line = data.endsWith('\r') || data.endsWith('\n') ? '' : null;
      return '';
    }
    if (PRINTABLE.test(data)) {
      if (this.line !== null) this.line += data;
      return this.atInput ? this.guess(data, ERASE, now) : '';
    }
    if (data === '\x7f' || data === '\b') {
      const line = this.line;
      if (line === null || line.length === 0) return '';
      this.line = line.slice(0, -1);
      return this.atInput ? this.guess(ERASE, line.slice(-1), now) : '';
    }
    // A paste, an arrow, a control key: sent as typed, drawn by the realm alone.
    this.line = null;
    return '';
  }

  /** A chunk from main: what to write, with the echoes already drawn taken out. */
  arrived(text: string, prompt: boolean): string {
    let out = '';
    let i = 0;
    while (i < text.length && this.guesses.length > 0) {
      const osc = stampEndAt(text, i);
      if (osc > i) {
        out += text.slice(i, osc);
        i = osc;
        continue;
      }
      const head = this.guesses[0]!;
      if (text[i] !== head.echo[this.matched]) break;
      i += 1;
      this.matched += 1;
      if (this.matched === head.echo.length) {
        this.guesses.shift();
        this.matched = 0;
        this.heard(head.at);
      }
    }
    const rest = text.slice(i);
    if (this.guesses.length > 0 && rest.length > 0) out += this.giveUp();
    if (visible(rest)) this.atInput = prompt;
    return out + rest;
  }

  /** What to write to take back every guess older than `limit` ms: the realm never echoed them. */
  expire(now: number, limit: number): string {
    const oldest = this.guesses[0];
    return oldest !== undefined && now - oldest.at >= limit ? this.giveUp() : '';
  }

  /** When the oldest guess was drawn, for the caller's timer; null with none. */
  get oldest(): number | null {
    return this.guesses[0]?.at ?? null;
  }

  /** The console was written again from main's record: nothing drawn here is on it. */
  reset(): void {
    this.guesses = [];
    this.matched = 0;
    this.atInput = false;
    this.line = null;
  }

  /** A key sent without being drawn: the line is no longer known, and nothing more is drawn until it is. Guesses on screen still wait for their echo. */
  forget(): void {
    this.atInput = false;
    this.line = null;
  }

  private guess(echo: string, undo: string, at: number): string {
    this.guesses.push({ echo, undo, at });
    return echo;
  }

  /** Undoes every guess not yet echoed, newest first, and stops drawing until the next prompt. */
  private giveUp(): string {
    // A guess the realm has begun echoing is undone whole: rare, and the next prompt redraws the row.
    const undo = this.guesses
      .map((guess) => guess.undo)
      .reverse()
      .join('');
    this.guesses = [];
    this.matched = 0;
    this.atInput = false;
    this.line = null;
    return undo;
  }
}

/** Whether `text` draws or moves anything, past colour and the client's stamps. */
function visible(text: string): boolean {
  return withoutSgr(unstamped(text)).length > 0;
}
