/**
 * The retained output of one session, so that attaching a terminal to it is
 * lossless, written down so that a launch is not what empties a console.
 * Escape sequences are kept intact, since the in-place status repaint replays
 * correctly only verbatim. Not the parser's line log (`lineLogLimit`).
 *
 * Kept on disk as segments of about `tuning.view.consolePageLines` lines in
 * `backscroll/<id>/` (`segmentFiles.ts`), each ending on a newline. Only the
 * open segment is held in memory; a page reaching past it reads closed ones.
 * `mudengine-session` › *The backscroll outlives the process* has the why.
 */
import fs from 'node:fs';

import type { BackscrollPage } from '../../shared/ipc';
import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { stripAnsi } from '../net/LineTokenizer';
import { PROMPT_REPAINT } from '../net/stream-quirks';
import { segmentPath, segmentsIn, segmentsInAsync } from './segmentFiles';

/** A segment's suffix, and the old one-file backscroll's. */
export const BACKSCROLL_EXT = '.log';

export interface BackscrollOptions {
  /** Lines retained: the terminal's own `terminal.scrollback`. Zero keeps the live line and writes nothing. */
  lines: number;
  /** The character's directory of segments. */
  dir: string;
  /** Settles once the old one-file backscroll has been split; nothing is read before it. */
  after?: Promise<void> | undefined;
  /** Said once, into the terminal, when the record cannot be read or written. */
  onProblem?: ((message: string) => void) | undefined;
}

interface Chunk {
  text: string;
  bytes: number;
  /** Newlines in it: what the cap counts. */
  lines: number;
}

/** A closed segment: on disk, never in memory. */
interface Closed {
  segment: number;
  lines: number;
}

/** What the record held when it was opened, for a page asked before then. */
interface Opened {
  closed: readonly Closed[];
  /** The open segment as it was read. */
  text: string;
}

/**
 * How far left the status repaint reaches. `CSI 79 D` moves the cursor 79
 * columns left and `CSI K` erases to the end of the line, so a row of at
 * most this many columns is wholly erased by it. See `coalesceRepaint`.
 */
const REPAINT_REACH = 79;

function measure(text: string): Chunk {
  return { text, bytes: Buffer.byteLength(text, 'utf8'), lines: newlines(text) };
}

function newlines(text: string): number {
  let lines = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines += 1;
  return lines;
}

/** Where the text after the first `skip` newlines starts. */
function afterNewlines(text: string, skip: number): number {
  let from = 0;
  for (let left = skip; left > 0; left -= 1) from = text.indexOf('\n', from) + 1;
  return from;
}

export class Backscroll {
  /** The open segment; before the record is opened, what was written since. */
  private chunks: Chunk[] = [];
  private openLines = 0;
  /** How many of `chunks` are in the open segment's file. */
  private written = 0;
  /** The open segment's number. */
  private segment = 1;
  private closed: Closed[] = [];
  private closedLines = 0;
  private limit: number;
  private timer: NodeJS.Timeout | null = null;
  private readonly reported = new Set<'readError' | 'saveError'>();
  /** `opening` until the record is read; `suspended` once it failed, and memory carries on. */
  private phase: 'opening' | 'open' | 'suspended' | 'closed' = 'opening';
  /** What a page asked for while opening waits on; null once opened. */
  private opening: Promise<Opened | null> | null;
  /** Settles once the record has been read, or could not be. Never rejects. */
  readonly ready: Promise<void>;

  constructor(private readonly options: BackscrollOptions) {
    this.limit = Math.max(0, Math.trunc(options.lines));
    // The split never rejects; were it to, the record is still read.
    const opening = (options.after ?? Promise.resolve()).then(
      () => this.open(),
      () => this.open()
    );
    this.opening = opening;
    this.ready = opening.then(() => undefined);
  }

  /**
   * The newest `lines` lines and whatever is after the last newline, starting
   * at a line boundary, and how many retained lines are older than them. What
   * it covers is fixed when it is called, so a page asked for at attach holds
   * exactly what was painted before it; only closed segments are read later.
   */
  page(lines: number): Promise<BackscrollPage> {
    const memory = this.chunks.map((chunk) => chunk.text).join('');
    const want = Math.max(0, Math.trunc(lines));
    if (this.opening === null) {
      return this.assemble(want, memory, this.openLines, [...this.closed]);
    }
    return this.opening.then((opened) =>
      this.assemble(
        want,
        `${opened?.text ?? ''}${memory}`,
        newlines(opened?.text ?? '') + newlines(memory),
        [...(opened?.closed ?? [])]
      )
    );
  }

  write(text: string): void {
    if (text.length === 0 || this.phase === 'closed') return;
    if (text.startsWith(PROMPT_REPAINT)) this.coalesceRepaint();
    const chunk = measure(text);
    this.chunks.push(chunk);
    this.openLines += chunk.lines;
    if (this.limit === 0) {
      this.keepLiveLine();
      return;
    }
    if (this.phase === 'opening') return;
    this.roll();
    this.trim();
    if (this.phase !== 'open' || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, tuning().records.backscrollFlushMs);
    // Never a reason to keep the process alive: `close()` writes what is held.
    this.timer.unref?.();
  }

  /** The cap changed under a running session: whole old segments go. */
  setLimit(lines: number): void {
    this.limit = Math.max(0, Math.trunc(lines));
    if (this.limit === 0) this.keepLiveLine();
    if (this.phase !== 'open') return;
    this.roll();
    this.trim();
  }

  /** Writes what is held. Called on a timer, and once on the way out. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.phase !== 'open' || this.limit === 0) return;
    this.persist(this.chunks.length, '');
  }

  /**
   * Writes anything outstanding and stops. Safe to call twice. Before the
   * record was read (a quit during the launch) what was painted is added to
   * the newest segment on disk, which the startup split puts after its own.
   */
  close(): void {
    if (this.phase === 'opening' && this.limit > 0 && this.chunks.length > 0) {
      this.phase = 'closed';
      try {
        this.segment = segmentsIn(this.options.dir, BACKSCROLL_EXT).at(-1) ?? 1;
        this.append(this.chunks.map((chunk) => chunk.text).join(''));
      } catch (error) {
        this.report('saveError', error);
      }
      return;
    }
    this.flush();
    this.phase = 'closed';
  }

  /** Lists the segments, counts the closed ones' lines, and reads the open one. */
  private async open(): Promise<Opened | null> {
    try {
      return await this.read();
    } finally {
      // From here a page reads memory, which now holds the open segment.
      this.opening = null;
    }
  }

  private async read(): Promise<Opened | null> {
    const dir = this.options.dir;
    let opened: Opened;
    try {
      const segments = await segmentsInAsync(dir, BACKSCROLL_EXT);
      const closed: Closed[] = [];
      for (const segment of segments.slice(0, -1)) {
        const text = await fs.promises.readFile(segmentPath(dir, segment, BACKSCROLL_EXT), 'utf8');
        closed.push({ segment, lines: newlines(text) });
      }
      const last = segments.at(-1);
      const text =
        last === undefined
          ? ''
          : await fs.promises.readFile(segmentPath(dir, last, BACKSCROLL_EXT), 'utf8');
      opened = { closed, text };
      this.segment = last ?? 1;
    } catch (error) {
      // A console that had a history and cannot be shown it: said once, and
      // nothing is written over a record this build could not read.
      if (this.phase === 'opening') {
        this.phase = 'suspended';
        this.report('readError', error);
      }
      return null;
    }
    if (this.phase !== 'opening') return opened;
    this.phase = 'open';
    this.closed = [...opened.closed];
    this.closedLines = this.closed.reduce((sum, each) => sum + each.lines, 0);
    if (opened.text.length > 0) {
      const loaded = measure(opened.text);
      this.chunks.unshift(loaded);
      this.openLines += loaded.lines;
      this.written = 1;
    }
    if (this.limit === 0) {
      this.keepLiveLine();
    } else {
      this.roll();
      this.trim();
      this.flush();
    }
    return opened;
  }

  /**
   * The open segment is closed once it holds a segment's lines, at its last
   * newline, so the next starts on a line and no escape sequence is cut.
   */
  private roll(): void {
    const per = Math.max(1, Math.min(tuning().view.consolePageLines, this.limit));
    if (this.openLines < per) return;
    let last = this.chunks.length - 1;
    while (last >= 0 && this.chunks[last]!.lines === 0) last -= 1;
    const cut = this.chunks[last]!;
    const at = cut.text.lastIndexOf('\n') + 1;
    const head = cut.text.slice(0, at);
    const tail = cut.text.slice(at);
    if (this.phase === 'open') {
      if (this.written > last) {
        // Written past the cut already (a lowered cap): the file ends at the cut.
        this.truncate(this.bytesBefore(last) + Buffer.byteLength(head, 'utf8'));
      } else {
        this.persist(last, head);
      }
    }
    if (this.phase === 'open') {
      this.closed.push({ segment: this.segment, lines: this.openLines });
      this.closedLines += this.openLines;
    }
    this.segment += 1;
    this.chunks = [...(tail.length > 0 ? [measure(tail)] : []), ...this.chunks.slice(last + 1)];
    this.openLines = 0;
    this.written = 0;
  }

  /** Deletes whole closed segments while the newer ones still hold the cap. */
  private trim(): void {
    if (this.phase !== 'open') return;
    while (this.closed.length > 0) {
      const first = this.closed[0]!;
      if (this.closedLines - first.lines + this.openLines < this.limit) break;
      try {
        fs.rmSync(segmentPath(this.options.dir, first.segment, BACKSCROLL_EXT), { force: true });
      } catch (error) {
        this.fail(error);
        return;
      }
      this.closed.shift();
      this.closedLines -= first.lines;
    }
  }

  /** At a cap of zero: only what follows the last newline, and nothing on disk. */
  private keepLiveLine(): void {
    let last = this.chunks.length - 1;
    while (last >= 0 && this.chunks[last]!.lines === 0) last -= 1;
    if (last >= 0) {
      const cut = this.chunks[last]!;
      const tail = cut.text.slice(cut.text.lastIndexOf('\n') + 1);
      this.chunks = [...(tail.length > 0 ? [measure(tail)] : []), ...this.chunks.slice(last + 1)];
      this.openLines = 0;
    }
    if (this.phase !== 'open') return;
    try {
      for (const each of this.closed) {
        fs.rmSync(segmentPath(this.options.dir, each.segment, BACKSCROLL_EXT), { force: true });
      }
      fs.rmSync(this.openFile(), { force: true });
    } catch (error) {
      this.fail(error);
    }
    this.closed = [];
    this.closedLines = 0;
    this.written = 0;
  }

  /** Appends `chunks[written..upTo)` and then `extra` to the open segment's file. */
  private persist(upTo: number, extra: string): void {
    if (this.phase !== 'open') return;
    const text =
      this.chunks
        .slice(this.written, upTo)
        .map((chunk) => chunk.text)
        .join('') + extra;
    if (text.length === 0) return;
    try {
      this.append(text);
    } catch (error) {
      this.fail(error);
      return;
    }
    this.written = upTo;
  }

  private append(text: string): void {
    fs.mkdirSync(this.options.dir, { recursive: true });
    fs.appendFileSync(this.openFile(), text, 'utf8');
  }

  /** Cuts the open segment's file back to `bytes`, for a repaint that erased what it held. */
  private truncate(bytes: number): void {
    try {
      fs.truncateSync(this.openFile(), bytes);
    } catch (error) {
      this.fail(error);
    }
  }

  private openFile(): string {
    return segmentPath(this.options.dir, this.segment, BACKSCROLL_EXT);
  }

  private bytesBefore(index: number): number {
    let bytes = 0;
    for (let i = 0; i < index; i += 1) bytes += this.chunks[i]!.bytes;
    return bytes;
  }

  /**
   * Joins the open segment's text, read at the call, to as many closed
   * segments, newest first, as the page needs. The retained lines are the cap's
   * worth at most, though whole segments are kept on disk.
   */
  private async assemble(
    want: number,
    memory: string,
    memoryLines: number,
    closed: Closed[]
  ): Promise<BackscrollPage> {
    const retained = Math.min(
      this.limit,
      memoryLines + closed.reduce((sum, each) => sum + each.lines, 0)
    );
    const take = Math.min(want, retained);
    const parts = [memory];
    let have = memoryLines;
    while (have < take && closed.length > 0) {
      const each = closed.pop()!;
      let text: string;
      try {
        text = await fs.promises.readFile(
          segmentPath(this.options.dir, each.segment, BACKSCROLL_EXT),
          'utf8'
        );
      } catch (error) {
        // Trimmed away while this was being read: there is nothing older.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.report('readError', error);
        return { text: parts.join(''), older: 0 };
      }
      parts.unshift(text);
      have += each.lines;
    }
    const from = afterNewlines(parts[0]!, Math.max(0, have - take));
    parts[0] = parts[0]!.slice(from);
    const shown = Math.min(have, take);
    return { text: parts.join(''), older: retained - shown };
  }

  /** Stops writing for the rest of the session and says why, once. Memory carries on. */
  private fail(error: unknown): void {
    if (this.phase !== 'open') return;
    this.phase = 'suspended';
    this.report('saveError', error);
  }

  /** Each kind of problem is said once. */
  private report(kind: 'readError' | 'saveError', error: unknown): void {
    if (this.reported.has(kind)) return;
    this.reported.add(kind);
    const params = { dir: this.options.dir, message: errorMessage(error) };
    this.options.onProblem?.(
      kind === 'readError'
        ? t('notices.session.backscroll.readError', params)
        : t('notices.session.backscroll.saveError', params)
    );
  }

  /**
   * A status repaint arriving erases the row it lands on, so what that row
   * held is dropped rather than kept for ever.
   *
   * The realm repaints its prompt unprompted every thirty seconds, and the
   * repaint carries no newline, so a character standing idle grew the tail,
   * and the file, by one chunk a repaint with no cap behind it. Only the
   * trailing chunks with no newline go, only while the row they make (with
   * whatever the last newline chunk left on it) is within the repaint's
   * reach and holds no carriage return, so a replay draws the same screen:
   * the cursor lands at column zero and the erase takes the whole row. What
   * was already written of them is cut off the file.
   */
  private coalesceRepaint(): void {
    let start = this.chunks.length;
    while (start > 0 && this.chunks[start - 1]?.lines === 0) start -= 1;
    // Before the record is read, the row may have begun in the open segment.
    if (start === this.chunks.length || (start === 0 && this.phase === 'opening')) return;
    const last = this.chunks[start - 1];
    const left = last === undefined ? '' : last.text.slice(last.text.lastIndexOf('\n') + 1);
    let width = stripAnsi(left).length;
    if (left.includes('\r')) return;
    for (const chunk of this.chunks.slice(start)) {
      if (chunk.text.includes('\r')) return;
      width += stripAnsi(chunk.text).length;
    }
    if (width > REPAINT_REACH) return;
    if (this.phase === 'open' && this.written > start) {
      this.truncate(this.bytesBefore(start));
      this.written = start;
    }
    this.chunks.splice(start);
  }
}
