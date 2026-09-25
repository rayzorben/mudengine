/**
 * When the line pipeline speaks: what the feed decided the terminal sees,
 * pushed once a chunk has been framed and fed, and the unterminated tail
 * framed as a line once the server has gone quiet, or at once where it is a
 * finished prompt. `TerminalFeed` decides *what* is painted; this decides
 * *when*, and owns the one clock that does. See `mudengine-session` › *The
 * terminal is fed framed lines*, and `mudengine-wire` › *Line framing* for
 * the quiet period's measurements.
 */
import { tuning } from '../app/tuning';
import { stripAnsi, type FramedLine, type LineTokenizer } from '../net/LineTokenizer';
import { STATUS_LINE } from '../parse/patterns';
import { promptOpened, type Emitted, type TerminalFeed } from './TerminalFeed';
import type { StreamChunk } from '../../shared/types';

/**
 * Whether the tail ends where a prompt ends, and so is a line the server has
 * finished rather than one it is still in the middle of.
 *
 * The quiet period exists for prompts alone, and 150ms of silence only means
 * *ended* for a line that was going to end by going quiet. Over the internet
 * it does not mean that for anything else: bearfather's BBS paused 178ms
 * between `Intersection of River St. & Mystic Alle` and its `y`, and the
 * fragment framed as a whole line became a room, was learned into the
 * character's memory as a place, and stopped the walk. Every prompt this
 * client has answered ends at `:` or `?` — `Please enter your username or
 * "new":`, `(N)onstop, (Q)uit, or (C)ontinue?`, `[HP=33]:` — and every
 * sentence the wire cut ended mid-word. `STATUS_LINE` carries the realms that
 * put a state after the colon, and the echo glued onto a finished prompt.
 *
 * See `mudengine-wire` § Line framing is not CRLF for the measurement.
 */
function endsLikePrompt(plain: string): boolean {
  return /[:?]\s*$/.test(plain) || STATUS_LINE.test(plain);
}

/** What the tail is read from and what a paint takes. */
export interface PaintParts {
  readonly tokenizer: Pick<LineTokenizer, 'buffered' | 'flush'>;
  readonly feed: Pick<TerminalFeed, 'take'>;
  /** The quiet after which a prompt-shaped tail is a line: the session's `IDLE_FLUSH_MS`. */
  readonly quietMs: number;
}

/** What the session that built this does with what it frames and paints. */
export interface PaintSession {
  /** A line the tail framed: classified, fed and acted on (`SessionManager.publishLine`). */
  publish(framed: FramedLine, at: number): void;
  /** What the terminal is shown (`SessionSink.data`). */
  data(chunk: StreamChunk): void;
}

export class Paint {
  private readonly tokenizer: PaintParts['tokenizer'];
  private readonly feed: PaintParts['feed'];
  private readonly quietMs: number;
  private seq = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  /** When the tail now buffered first looked like a prompt still being written. */
  private promptOpenedAt: number | null = null;
  /**
   * Whether this realm writes its state after the prompt's colon
   * (`[HP=10/40]: (Resting)`). Then the colon is not where a prompt ends, and
   * `tailIsWholePrompt` may not frame one at it.
   */
  private promptTrails = false;

  constructor(
    parts: PaintParts,
    private readonly session: PaintSession
  ) {
    this.tokenizer = parts.tokenizer;
    this.feed = parts.feed;
    this.quietMs = parts.quietMs;
  }

  /**
   * A chunk's lines have been framed and fed, and its tail with them: what
   * the feed decided is painted, then the tail is framed now or the quiet
   * period is started over.
   */
  afterChunk(at: number): void {
    this.paint(at);
    /*
     * A prompt the server has finished writing is framed now, not after
     * the quiet period: it carries the vitals and credits the next queued
     * command, and nothing follows a finished `]:` on the wire but this
     * client's own echo (`mudengine-wire` § Line framing, 2026-09-11).
     */
    if (this.tailIsWholePrompt()) this.flush();
    else this.armIdleFlush();
  }

  /** A held tail the feed's own timer released, outside any chunk: painted as a chunk of its own. */
  released(emitted: Emitted): void {
    this.push(emitted, Date.now());
  }

  /** Whatever is pending, framed and painted now: the quiet period ran out, or the socket closed. */
  flush(): void {
    this.cancelIdleFlush();
    this.promptOpenedAt = null;
    const at = Date.now();
    for (const framed of this.tokenizer.flush()) this.session.publish(framed, at);
    this.paint(at);
  }

  /** A line was framed: whatever was opening has been, and the next tail is a new one. */
  lineFramed(): void {
    this.promptOpenedAt = null;
  }

  /** A status line was framed: whether this realm's prompt trails a state past its colon. */
  noteStatusLine(plain: string): void {
    if (this.promptTrails) return;
    this.promptTrails = STATUS_LINE.exec(plain.trimStart())?.groups?.['stateB'] !== undefined;
  }

  /** A new connection: no clock, no prompt opening, a realm whose prompt is not yet known. */
  reset(): void {
    this.cancelIdleFlush();
    this.promptOpenedAt = null;
    this.promptTrails = false;
  }

  dispose(): void {
    this.cancelIdleFlush();
  }

  /** Restarts the quiet-period timer that releases a trailing prompt. */
  private armIdleFlush(): void {
    this.cancelIdleFlush();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.flush();
    }, this.idleFlushDelay());
    // Never the reason a process stays alive.
    this.idleTimer.unref?.();
  }

  /**
   * How long the quiet period is, given what is buffered.
   *
   * A prompt is a line that ends because the server went quiet — but a
   * prompt that has opened its bracket and not closed it has not ended, and
   * the server has not gone quiet, whatever the clock says. The bearfather
   * BBS writes `[HP=40/40,…,S= (Resting)` and then ` ]:` about a tenth of a
   * second later, longer than `IDLE_FLUSH_MS` a quarter of the time, and a
   * flush between the two framed the halves as two lines neither of which
   * read as a status line: the vitals and the resting state on every such
   * prompt were lost. So an opened prompt waits `promptHoldMs` from when it
   * was first seen opening, which is the bound on a prompt the server never
   * finishes, and never less than the ordinary quiet period. A finished
   * prompt is released as it always was.
   *
   * And a tail that is not a prompt at all waits `sentenceHoldMs`, because
   * the quiet period is a prompt's and nothing else's: see
   * {@link endsLikePrompt} for the half-written room name that became a room.
   */
  private idleFlushDelay(): number {
    const plain = stripAnsi(this.tokenizer.buffered).trimStart();
    if (!promptOpened(plain) || STATUS_LINE.test(plain)) {
      this.promptOpenedAt = null;
      return endsLikePrompt(plain) ? this.quietMs : tuning().session.sentenceHoldMs;
    }
    const now = Date.now();
    this.promptOpenedAt ??= now;
    return Math.max(this.quietMs, tuning().session.promptHoldMs - (now - this.promptOpenedAt));
  }

  /**
   * Whether the unterminated tail is a status line the server has finished:
   * the colon closes it and nothing follows. `STATUS_LINE` accepts `]` alone
   * and a state after the colon, and neither of those is a finished prompt.
   */
  private tailIsWholePrompt(): boolean {
    if (this.promptTrails) return false;
    const plain = stripAnsi(this.tokenizer.buffered).trimStart();
    const match = STATUS_LINE.exec(plain);
    return match !== null && match[0].endsWith(':') && match[0].length === plain.trimEnd().length;
  }

  private cancelIdleFlush(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Pushes whatever the feed decided the terminal sees, if anything. */
  private paint(at: number): void {
    const emitted = this.feed.take();
    if (emitted.text.length === 0) return;
    this.push(emitted, at);
  }

  private push(emitted: Emitted, at: number): void {
    this.seq += 1;
    this.session.data({
      seq: this.seq,
      at,
      text: emitted.text,
      ...(emitted.marks.length > 0 ? { marks: emitted.marks } : {})
    });
  }
}
