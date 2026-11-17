/**
 * The Talk card's history, written down — so quitting and restarting restores
 * the conversation instead of starting the card empty.
 *
 * One plain JSONL file per character (`talk/<id>.jsonl`), one conversation
 * block per line, exactly as the card consumed it live: the block *is* the
 * fact, and re-deriving a second record shape from it would be a copy to keep
 * in step. Plain rather than gzipped like the fights beside it, on purpose —
 * a conversation is the one record here somebody might grep by hand, and a
 * year of talk is a few tens of megabytes at the very worst.
 *
 * ## Opened once, pruned then
 *
 * The file is read once, when the session is created. Lines older than the
 * configured retention (`logging.conversationDays`) are dropped, and when
 * anything was dropped — by age, or a torn last line from a crash mid-append —
 * the file is rewritten atomically so the cleanup actually happens on disk
 * rather than being re-done against a growing file every launch. The tail is
 * kept in memory (by `talkExcess`, the rule the card keeps by) to answer
 * `backlog()` for every later attach without re-reading the file. `page()`
 * reads further back by line number (`mudengine-ui` › `parts/console.md`).
 *
 * ## The FightLog's rules, for the FightLog's reasons
 *
 * - **Never blocks the parse path.** `append` pushes and returns; the write
 *   happens on a timer (`records.talkFlushMs`), flushed on the way out.
 * - **Never grows without limit in memory.** The pending batch is capped
 *   (`records.talkHeld`) and drops the oldest.
 * - **Never takes a session down.** A directory that cannot be written is
 *   reported once and then let alone.
 * - **Tolerant reads.** One malformed line costs one message, not the file.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DAY_MS, errorMessage } from '../../shared/values';
import type { Block } from '../../shared/blocks';
import { NO_TALK_PAGE, talkExcess, talkKeepOf, type TalkPage } from '../../shared/talkLog';
import { tuning } from '../app/tuning';
import { writeWholeSync } from '../app/writeWhole';

/** What a session hands its conversation to, and what an attach reads back. */
export interface TalkSink {
  append(block: Block): void;
  backlog(): TalkPage;
  /** The page of lines ending before line `before`; `NO_TALK_PAGE` when none can be read. */
  page(before: number): Promise<TalkPage>;
}

/** The sink used when `logging.conversations` is off: writes and restores nothing. */
export const NO_TALK: TalkSink = {
  append: () => {},
  backlog: () => NO_TALK_PAGE,
  page: () => Promise.resolve(NO_TALK_PAGE)
};

export interface TalkLogEvents {
  /** Said once, into the terminal, when the file cannot be written. */
  notice?(message: string): void;
}

export class TalkLog implements TalkSink {
  /** The restored tail plus everything appended since, trimmed by `talkExcess`. */
  private recent: Block[];
  /** Lines the log holds, written or not: the number of the next one appended. */
  private total = 0;
  /** The byte each written line starts at, and where the next will. */
  private starts: number[] = [];
  private size = 0;
  /** False once the file is out of step with the line numbers; `page()` then answers nothing. */
  private inStep = true;
  /** Appended and not yet written. */
  private held: Block[] = [];
  private timer: NodeJS.Timeout | null = null;
  private complained = false;

  /**
   * @param file Where the log lives. Read and pruned here, appended afterwards.
   * @param keepDays Retention at the moment of opening; the prune is a
   *   once-per-launch decision, so a later config edit reaches the next one.
   */
  constructor(
    private readonly file: string,
    keepDays: number,
    private readonly events: TalkLogEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {
    this.recent = this.open(keepDays);
  }

  /** What an attaching window should seed the Talk card with, oldest first. */
  backlog(): TalkPage {
    return { blocks: [...this.recent], start: this.total - this.recent.length };
  }

  /**
   * Reads the lines before `before` off the disk, `view.talkPageLines` of
   * them. A line that will not parse costs that line; a read that fails is
   * said once and answered with nothing.
   */
  async page(before: number): Promise<TalkPage> {
    // What is held has no place on disk until it is written.
    this.flush();
    if (!this.inStep || !Number.isInteger(before)) return NO_TALK_PAGE;
    const end = Math.min(before, this.starts.length);
    if (end <= 0) return NO_TALK_PAGE;
    const start = Math.max(0, end - Math.max(1, tuning().view.talkPageLines));
    const from = this.starts[start]!;
    const to = this.starts[end] ?? this.size;
    try {
      const text = await readSpan(this.file, from, to - from);
      return { blocks: text.split('\n').flatMap(asBlock), start };
    } catch (error) {
      this.complain(
        `The conversation log at ${this.file} could not be read: ${errorMessage(error)}`
      );
      return NO_TALK_PAGE;
    }
  }

  append(block: Block): void {
    this.total += 1;
    this.recent.push(block);
    const excess = talkExcess(this.recent, this.now(), talkKeepOf(tuning().view));
    if (excess > 0) this.recent.splice(0, excess);
    this.held.push(block);
    if (this.held.length > tuning().records.talkHeld) {
      // A numbered line that will never be written.
      this.held.shift();
      this.inStep = false;
      this.complain(
        `The conversation log at ${this.file} was not written in time and a line was dropped from it; the Talk card reads no further back until the client restarts.`
      );
    }
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, tuning().records.talkFlushMs);
    // Never a reason to keep the process alive: what is held is worth writing,
    // and `teardown()` writes it.
    this.timer.unref?.();
  }

  /** Writes what is held. Called on a timer, and once on the way out. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.held.length === 0) return;
    const batch = this.held;
    // Cleared before the write: a write that throws has been reported, and
    // retrying it against a path that is not going to start working would
    // grow the buffer for the rest of the session.
    this.held = [];

    const lines = batch.map((block) => `${JSON.stringify(block)}\n`);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, lines.join(''), 'utf8');
      this.wrote(lines);
    } catch (error) {
      this.inStep = false;
      this.complain(
        `The conversation log could not be written to ${this.file}: ${errorMessage(error)}`
      );
    }
  }

  /** Notes where each line just written starts. Each of `lines` ends in its newline. */
  private wrote(lines: readonly string[]): void {
    for (const line of lines) {
      this.starts.push(this.size);
      this.size += Buffer.byteLength(line, 'utf8');
    }
  }

  /** Said once. A file that will not open will not open again either. */
  private complain(message: string): void {
    if (this.complained) return;
    this.complained = true;
    this.events.notice?.(message);
  }

  dispose(): void {
    this.flush();
  }

  /**
   * Reads the file, drops what has aged out, rewrites when anything was
   * dropped, and returns the in-memory tail.
   *
   * The rewrite is temp-file-and-rename, so a crash mid-prune leaves the old
   * file whole rather than half of one — and it only happens when the content
   * actually changed, so the ordinary launch touches nothing.
   */
  private open(keepDays: number): Block[] {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      // No file yet is the ordinary first run and says nothing. Any other
      // failure is a log that exists and cannot be read — said out loud once,
      // because an empty Talk card and "nobody said anything" are otherwise
      // indistinguishable. The prune is skipped (there is nothing safe to
      // rewrite from), and the one-complaint flag keeps a later append from
      // repeating the news.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.inStep = false;
        this.complain(
          `The conversation log at ${this.file} could not be read: ${errorMessage(error)}`
        );
      }
      return [];
    }

    const cutoff = this.now() - keepDays * DAY_MS;
    const kept: Block[] = [];
    const lines: string[] = [];
    for (const line of text.split('\n')) {
      // A torn last line is what a crash mid-append leaves; the prune below
      // is what takes it off the disk.
      const [block] = asBlock(line);
      if (block === undefined || block.at < cutoff) continue;
      kept.push(block);
      lines.push(`${line}\n`);
    }

    // Anything but the kept lines, each ending in its newline, is rewritten:
    // a dropped line, a blank one, a last line with no newline after it.
    const whole = lines.join('');
    if (whole !== text) {
      try {
        writeWholeSync(this.file, whole);
      } catch (error) {
        // The prune failing costs disk space and the pages further back, never
        // the session and never the backlog, which is already in hand.
        this.inStep = false;
        this.complain(
          `The conversation log at ${this.file} could not be pruned: ${errorMessage(error)}`
        );
      }
    }

    this.total = kept.length;
    this.wrote(lines);
    return kept.slice(talkExcess(kept, this.now(), talkKeepOf(tuning().view)));
  }
}

/** One line of the file as its block, or nothing where it is blank, torn or carries no time. */
function asBlock(line: string): Block[] {
  if (line.length === 0) return [];
  try {
    const block = JSON.parse(line) as Block;
    return typeof block.at === 'number' ? [block] : [];
  } catch {
    return [];
  }
}

/** `length` bytes of a file from `from`, as text. The handle is closed either way. */
async function readSpan(file: string, from: number, length: number): Promise<string> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, from);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}
