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
 * kept in memory (capped at `view.talkLimit`, the same figure the card keeps)
 * to answer `backlog()` for every later attach without re-reading the file.
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

import { errorMessage } from '../../shared/values';
import type { Block } from '../../shared/blocks';
import { tuning } from '../app/tuning';

/** What a session hands its conversation to, and what an attach reads back. */
export interface TalkSink {
  append(block: Block): void;
  backlog(): Block[];
}

/** The sink used when `logging.conversations` is off: writes and restores nothing. */
export const NO_TALK: TalkSink = {
  append: () => {},
  backlog: () => []
};

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TalkLogEvents {
  /** Said once, into the terminal, when the file cannot be written. */
  notice?(message: string): void;
}

export class TalkLog implements TalkSink {
  /** The restored tail plus everything appended since, capped at `view.talkLimit`. */
  private recent: Block[];
  /** Appended and not yet written. */
  private held: Block[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Reported once. A file that will not open will not open again either. */
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
  backlog(): Block[] {
    return [...this.recent];
  }

  append(block: Block): void {
    this.recent.push(block);
    if (this.recent.length > tuning().view.talkLimit) this.recent.shift();
    this.held.push(block);
    if (this.held.length > tuning().records.talkHeld) this.held.shift();
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

    const lines = batch.map((block) => `${JSON.stringify(block)}\n`).join('');
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, lines, 'utf8');
    } catch (error) {
      if (this.complained) return;
      this.complained = true;
      this.events.notice?.(
        `The conversation log could not be written to ${this.file}: ${errorMessage(error)}`
      );
    }
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
        this.complained = true;
        this.events.notice?.(
          `The conversation log at ${this.file} could not be read: ${errorMessage(error)}`
        );
      }
      return [];
    }

    const cutoff = this.now() - keepDays * DAY_MS;
    const kept: Block[] = [];
    let dropped = false;
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      let block: Block;
      try {
        block = JSON.parse(line) as Block;
      } catch {
        // A torn last line is what a crash mid-append leaves; the prune below
        // is what takes it off the disk.
        dropped = true;
        continue;
      }
      if (typeof block.at !== 'number' || block.at < cutoff) {
        dropped = true;
        continue;
      }
      kept.push(block);
    }

    if (dropped) {
      try {
        const temp = `${this.file}.tmp`;
        fs.writeFileSync(temp, kept.map((block) => `${JSON.stringify(block)}\n`).join(''), 'utf8');
        fs.renameSync(temp, this.file);
      } catch (error) {
        // The prune failing costs disk space, never the session — and never
        // the backlog, which is already in hand.
        if (!this.complained) {
          this.complained = true;
          this.events.notice?.(
            `The conversation log at ${this.file} could not be pruned: ${errorMessage(error)}`
          );
        }
      }
    }

    return kept.slice(-tuning().view.talkLimit);
  }
}
