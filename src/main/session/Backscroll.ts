/**
 * The retained output of one session, so that attaching a terminal to it is
 * lossless — and written down, so that a launch is not what empties a console.
 *
 * xterm rebuilds its state from a byte stream, so catching a terminal up is
 * writing everything that happened: a tab popped out or back, a renderer
 * reloaded, and now the client opened again. Kept in lines — the terminal's
 * own `terminal.scrollback`, so nothing is replayed the terminal would not
 * keep — escape sequences intact, since the in-place status repaint replays
 * correctly only verbatim. Not the parser's line log (`lineLogLimit`).
 *
 * `mudengine-session` › *The backscroll outlives the process* has the why.
 */
import fs from 'node:fs';
import path from 'node:path';

import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { stripAnsi } from '../net/LineTokenizer';
import { PROMPT_REPAINT } from '../net/stream-quirks';

export interface BackscrollOptions {
  /** Lines retained: the terminal's own `terminal.scrollback`. Zero keeps the live line and writes nothing. */
  lines: number;
  /** Where the retained output is kept between launches; none keeps it in memory only. */
  file?: string | undefined;
  /** Said once, into the terminal, when the file cannot be read or written. */
  onProblem?: ((message: string) => void) | undefined;
}

interface Chunk {
  text: string;
  bytes: number;
  /** Newlines in it: what the cap counts. */
  lines: number;
}

/**
 * How far left the status repaint reaches. `CSI 79 D` moves the cursor 79
 * columns left and `CSI K` erases to the end of the line, so a row of at
 * most this many columns is wholly erased by it. See `coalesceRepaint`.
 */
const REPAINT_REACH = 79;

function measure(text: string): Chunk {
  let lines = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines += 1;
  return { text, bytes: Buffer.byteLength(text, 'utf8'), lines };
}

export class Backscroll {
  private chunks: Chunk[] = [];
  /**
   * How much of the first chunk has been dropped, so cutting it is a moved
   * index rather than a copy: a restored file is one chunk holding the whole
   * cap, and copying it on every painted line cost 3ms a line at the shipped
   * cap (measured 2026-09-18, the reviewer's `trim.mjs`). The first chunk's
   * `bytes` and `lines` count only what is behind the head; the prefix is
   * copied away once it outweighs what is kept, so the cost is amortised.
   */
  private head = 0;
  private total = 0;
  private count = 0;
  private limit: number;
  /** Written to memory and not yet to the file. */
  private held: string[] = [];
  private heldBytes = 0;
  /** What the file holds, as far as this process knows. */
  private fileBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  /** True once the file failed; memory carries on and nothing more is written. */
  private suspended = false;

  constructor(private readonly options: BackscrollOptions) {
    this.limit = Math.max(0, Math.trunc(options.lines));
    if (options.file !== undefined) this.open(options.file);
  }

  /** Complete lines retained. */
  get lines(): number {
    return this.count;
  }

  /** Everything retained, oldest first, ready to be written to a terminal. */
  get text(): string {
    return this.chunks
      .map((chunk, index) => (index === 0 ? chunk.text.slice(this.head) : chunk.text))
      .join('');
  }

  write(text: string): void {
    if (text.length === 0) return;
    if (text.startsWith(PROMPT_REPAINT)) this.coalesceRepaint();
    const chunk = measure(text);
    this.chunks.push(chunk);
    this.total += chunk.bytes;
    this.count += chunk.lines;
    this.trim();
    if (this.options.file === undefined || this.suspended || this.limit === 0) return;
    this.held.push(text);
    this.heldBytes += chunk.bytes;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, tuning().records.backscrollFlushMs);
    // Never a reason to keep the process alive: `close()` writes what is held.
    this.timer.unref?.();
  }

  /** The cap changed under a running session. */
  setLimit(lines: number): void {
    this.limit = Math.max(0, Math.trunc(lines));
    this.trim();
  }

  /** Writes what is held. Called on a timer, and once on the way out. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const file = this.options.file;
    if (file === undefined || this.suspended || this.held.length === 0) return;
    const batch = this.held.join('');
    const bytes = this.heldBytes;
    this.held = [];
    this.heldBytes = 0;
    /*
     * Rewritten whole once the file holds `backscrollRewriteAt` times what is
     * kept, rather than appended to for ever: it is read whole at launch, and
     * a cap on the lines kept is not a cap on a file that only grows.
     */
    if (this.fileBytes + bytes > this.total * tuning().records.backscrollRewriteAt) {
      this.rewrite(file);
      return;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, batch, 'utf8');
      this.fileBytes += bytes;
    } catch (error) {
      this.fail(file, error);
    }
  }

  /** Writes anything outstanding and stops the timer. Safe to call twice. */
  close(): void {
    this.flush();
  }

  private open(file: string): void {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      // No file yet is the first launch and says nothing. Any other failure
      // is a console that had a history and cannot be shown it — said once,
      // and nothing is written over a file this build could not read.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.suspended = true;
      this.options.onProblem?.(
        t('notices.session.backscroll.readError', {
          fileName: path.basename(file),
          message: errorMessage(error)
        })
      );
      return;
    }
    if (text.length === 0) return;
    const chunk = measure(text);
    this.fileBytes = chunk.bytes;
    this.chunks.push(chunk);
    this.total += chunk.bytes;
    this.count += chunk.lines;
    this.trim();
    // The file held more than is kept: made the buffer again now, so the next
    // launch reads only what it will show.
    if (this.fileBytes > this.total) this.rewrite(file);
  }

  private rewrite(file: string): void {
    const temporary = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, this.text, 'utf8');
      fs.renameSync(temporary, file);
      this.fileBytes = this.total;
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      this.fail(file, error);
    }
  }

  /** Stops writing for the rest of the session and says why, once. Memory carries on. */
  private fail(file: string, error: unknown): void {
    if (this.suspended) return;
    this.suspended = true;
    this.held = [];
    this.heldBytes = 0;
    this.options.onProblem?.(
      t('notices.session.backscroll.saveError', {
        fileName: path.basename(file),
        message: errorMessage(error)
      })
    );
  }

  /**
   * A status repaint arriving erases the row it lands on, so what that row
   * held is dropped rather than kept for ever.
   *
   * The realm repaints its prompt unprompted every thirty seconds, and the
   * repaint carries no newline, so a character standing idle grew the tail —
   * and the file — by one chunk a repaint with no cap behind it. Only the
   * trailing chunks with no newline go, only while the row they make (with
   * whatever the last newline chunk left on it) is within the repaint's
   * reach and holds no carriage return, so a replay draws the same screen:
   * the cursor lands at column zero and the erase takes the whole row.
   */
  private coalesceRepaint(): void {
    let start = this.chunks.length;
    while (start > 0 && this.chunks[start - 1]?.lines === 0) start -= 1;
    if (start === this.chunks.length) return;
    const last = this.chunks[start - 1];
    const left =
      last === undefined
        ? ''
        : (start - 1 === 0 ? last.text.slice(this.head) : last.text).slice(
            last.text.lastIndexOf('\n') + 1
          );
    let width = stripAnsi(left).length;
    if (left.includes('\r')) return;
    for (const chunk of this.chunks.slice(start)) {
      if (chunk.text.includes('\r')) return;
      width += stripAnsi(chunk.text).length;
    }
    if (width > REPAINT_REACH) return;
    for (const chunk of this.chunks.splice(start)) this.total -= chunk.bytes;
    if (this.chunks.length === 0) this.head = 0;
  }

  /**
   * Drops whole chunks off the front while what is behind them still holds
   * the cap, then moves the first chunk's head past its excess newlines.
   *
   * Two properties, in priority order. **The newest output is never dropped**:
   * the cap protects memory and the launch's replay; it must not cost the
   * live screen, so one chunk longer than the whole cap keeps its newest
   * lines. **The replay begins at a line boundary**: a stream cut inside an
   * escape sequence spends the first visible line recovering from a control
   * sequence with no introducer, and a cut just past a newline cannot.
   */
  private trim(): void {
    while (this.chunks.length > 1) {
      const first = this.chunks[0];
      if (first === undefined || this.count - first.lines < this.limit) break;
      this.chunks.shift();
      this.head = 0;
      this.total -= first.bytes;
      this.count -= first.lines;
    }
    const first = this.chunks[0];
    if (first === undefined || this.count <= this.limit) return;
    const excess = this.count - this.limit;
    let from = this.head;
    for (let left = excess; left > 0; left -= 1) from = first.text.indexOf('\n', from) + 1;
    const droppedBytes = Buffer.byteLength(first.text.slice(this.head, from), 'utf8');
    this.total -= droppedBytes;
    this.count -= excess;
    if (from >= first.text.length) {
      this.chunks.shift();
      this.head = 0;
      return;
    }
    this.head = from;
    this.chunks[0] = {
      text: first.text,
      bytes: first.bytes - droppedBytes,
      lines: first.lines - excess
    };
    // The prefix outweighs what is kept: copy the kept part once, so the memory
    // behind a restored file is given back and the next cuts stay cheap.
    if (this.head * 2 >= first.text.length) {
      this.chunks[0] = measure(first.text.slice(this.head));
      this.head = 0;
    }
  }
}
