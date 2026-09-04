/**
 * Every fight this character has been in, written down.
 *
 * One file per character, beside the options file, appended and never revised.
 * Nothing reads it yet and that is the point: every question worth asking about
 * how a character fights needs a record that predates the question, and a
 * client that starts collecting on the day somebody asks has to wait a month
 * for an answer.
 *
 * ## Appendable *and* compressed
 *
 * `gzip` members concatenate. A file made of many independent members is one
 * valid gzip stream and every tool reads it whole — `zcat`, `gunzip`,
 * `zlib.gunzipSync`, all of them. So a flush appends its own member rather than
 * rewriting the file, which is what makes this safe:
 *
 * - **A crash costs the last flush, not the file.** There is no open stream
 *   holding a half-written deflate block; every byte on disk is already a
 *   complete member.
 * - **It can be read while the client is running.** Nothing is ever rewritten,
 *   so a reader either sees a record or does not see it yet.
 *
 * A fight record is a few hundred bytes and gzip's member overhead is about
 * twenty, so batching is worth doing but not worth waiting for. Records are
 * held for a moment and written on the next tick, or at the latest when the
 * client shuts down — the same lazy-write-with-a-flush-on-quit shape the lore
 * and the realm memory use, and `teardown()` already calls this one too.
 *
 * ## What it will not do
 *
 * - **It never blocks the parse path.** `record` pushes and returns; the write
 *   happens on a timer.
 * - **It never grows without limit in memory.** A buffer that somehow stopped
 *   being flushed would otherwise be the leak that takes a session down, so it
 *   is capped and drops the *oldest* — losing the beginning of a run rather
 *   than the fight that just happened.
 * - **It never takes a session down.** A directory that cannot be written is
 *   reported once and then let alone; a character in the realm must not be
 *   disconnected because a statistics file failed to open.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { errorMessage } from '../../shared/values';
import {
  AS_PRINTED,
  summarizeFights,
  type FightRecord,
  type FightSink,
  type FightSummary,
  type MobResolver
} from '../../shared/fights';
import { tuning } from '../app/tuning';

export interface FightLogEvents {
  /** Said once, into the terminal, when the file cannot be written. */
  notice?(message: string): void;
}

export class FightLog implements FightSink {
  private held: FightRecord[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Reported once. A file that will not open will not open again either. */
  private complained = false;

  /**
   * @param file Where to append. Created with its directory on first write.
   */
  constructor(
    private readonly file: string,
    private readonly events: FightLogEvents = {}
  ) {}

  record(fight: FightRecord): void {
    this.held.push(fight);
    if (this.held.length > tuning().records.fightsHeld) this.held.shift();
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, tuning().records.fightFlushMs);
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
    /*
     * Cleared *before* the write, not after.
     *
     * A write that throws has already been reported; holding the batch to retry
     * would mean retrying it on every subsequent flush for the rest of the
     * session, against a path that is not going to start working — and growing
     * the buffer while it did.
     */
    this.held = [];

    const lines = batch.map((fight) => `${JSON.stringify(fight)}\n`).join('');
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // One gzip member per flush. Members concatenate, so this is an append
      // rather than a rewrite and the file stays readable throughout.
      fs.appendFileSync(this.file, zlib.gzipSync(Buffer.from(lines, 'utf8')));
    } catch (error) {
      if (this.complained) return;
      this.complained = true;
      this.events.notice?.(
        `Fight statistics could not be written to ${this.file}: ${errorMessage(error)}`
      );
    }
  }

  dispose(): void {
    this.flush();
  }

  /**
   * What this character's record says about a monster: the file, plus what is
   * held and not yet written — a fight that ended a second ago counts. Read
   * on a click, never on a tick: the file is read whole each time, and a
   * lookup is something a person does.
   */
  summary(name: string, resolve: MobResolver = AS_PRINTED): FightSummary | null {
    return this.summaries([name], resolve).get(name) ?? null;
  }

  /**
   * Several names against one read of the file. A lookup returns up to a
   * dozen monsters, and reading and decompressing the whole record once per
   * monster would be the same file twelve times for one click.
   */
  summaries(
    names: readonly string[],
    resolve: MobResolver = AS_PRINTED
  ): Map<string, FightSummary> {
    const records = [...readFights(this.file), ...this.held];
    const out = new Map<string, FightSummary>();
    for (const name of names) {
      const summary = summarizeFights(records, name, resolve);
      if (summary !== null) out.set(name, summary);
    }
    return out;
  }
}

/**
 * Reads a log back. For a later analysis, and for the tests here.
 *
 * Tolerant on purpose: a truncated last member is exactly what a crash leaves,
 * and the right answer is every record before it rather than nothing.
 */
export function readFights(file: string): FightRecord[] {
  if (!fs.existsSync(file)) return [];
  let text: string;
  try {
    /*
     * `Z_SYNC_FLUSH` rather than the default `Z_FINISH`.
     *
     * A crash leaves a truncated final member, and the default treats that as a
     * corrupt stream and throws — returning nothing for a file whose first
     * thousand records are perfectly good. This returns everything it could
     * decode and stops, which is the only useful answer.
     */
    text = zlib
      .gunzipSync(fs.readFileSync(file), { finishFlush: zlib.constants.Z_SYNC_FLUSH })
      .toString('utf8');
  } catch {
    return [];
  }
  const fights: FightRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      fights.push(JSON.parse(line) as FightRecord);
    } catch {
      // One malformed line costs one fight, not the file.
    }
  }
  return fights;
}
