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
  foldFight,
  foldOutput,
  measuredPerRound,
  summarizeFolds,
  type FightFold,
  type FightFolds,
  type FightOutput,
  type FightOutputs,
  type FightRecord,
  type FightSink,
  type FightSummary,
  type MeasureAsk,
  type MeasuredOutput,
  type MobResolver
} from '../../shared/fights';
import { tuning } from '../app/tuning';

export interface FightLogEvents {
  /** Said once, into the terminal, when the file cannot be written. */
  notice?(message: string): void;
}

/** The file as it stood, folded both ways: per monster, and per level of what was dealt. */
interface FoldedRecord {
  folds: ReadonlyMap<string, FightFold>;
  outputs: ReadonlyMap<number, FightOutput>;
}

const NOTHING_FOLDED: FoldedRecord = { folds: new Map(), outputs: new Map() };

export class FightLog implements FightSink {
  private held: FightRecord[] = [];
  /** Every fight this instance has recorded, folded as it happened. */
  private readonly recorded: FightFolds = new Map();
  /** And what this character dealt in them, per level. */
  private readonly recordedOutput: FightOutputs = new Map();
  /**
   * What the file held before this instance opened it, folded once on the
   * first question and off the thread. See `pastRecord`.
   */
  private before: Promise<FoldedRecord> | null = null;
  /** The same, once it has arrived: `measured` is asked synchronously. */
  private past: FoldedRecord | null = null;
  /**
   * How long the file was when this instance opened it. Everything past that
   * is this instance's own, already in `recorded`, and is not read back.
   */
  private readonly priorBytes: number;
  private timer: NodeJS.Timeout | null = null;
  /** Reported once. A file that will not open will not open again either. */
  private complained = false;

  /**
   * @param file Where to append. Created with its directory on first write.
   */
  constructor(
    private readonly file: string,
    private readonly events: FightLogEvents = {}
  ) {
    this.priorBytes = lengthOf(file);
  }

  record(fight: FightRecord): void {
    this.held.push(fight);
    foldFight(this.recorded, fight);
    foldOutput(this.recordedOutput, fight);
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
   * What this character's record says about a monster: everything written
   * before this session, plus every fight this session has seen — a fight
   * that ended a second ago counts. Asked on a click, never on a tick.
   */
  async summary(name: string, resolve: MobResolver = AS_PRINTED): Promise<FightSummary | null> {
    return (await this.summaries([name], resolve)).get(name) ?? null;
  }

  /**
   * Several names against one record.
   *
   * The file is read **once per instance and off the thread**: 41,679 fights
   * gunzipped and parsed on a click cost the socket a full second, in the
   * middle of whatever the character was doing (`mudengine-world` § Every
   * fight is written down, 2026-09-11). What is kept is the fold per printed
   * name, so a question walks a few hundred names rather than the fights.
   */
  async summaries(
    names: readonly string[],
    resolve: MobResolver = AS_PRINTED
  ): Promise<Map<string, FightSummary>> {
    const before = (await this.pastRecord()).folds;
    const out = new Map<string, FightSummary>();
    for (const name of names) {
      const summary = summarizeFolds([before, this.recorded], name, resolve);
      if (summary !== null) out.set(name, summary);
    }
    return out;
  }

  /**
   * What this character deals a round at `level`, from the whole record —
   * the hunting survey's rounds where the realm's arithmetic declines.
   *
   * Synchronous, because the survey is: until the file has been folded this
   * answers from this session's fights alone and starts the fold, and
   * `ready()` is what a caller that can wait awaits first.
   */
  measured(level: number, ask: MeasureAsk): MeasuredOutput | null {
    if (this.past === null) void this.pastRecord();
    return measuredPerRound(
      [this.past?.outputs ?? NOTHING_FOLDED.outputs, this.recordedOutput],
      level,
      ask
    );
  }

  /** Resolves once the file as it stood has been folded. */
  async ready(): Promise<void> {
    await this.pastRecord();
  }

  /**
   * The record as it stood before this instance, folded. Started by the first
   * question and shared by every later one; a file that cannot be read is
   * said out loud once and answers as empty, so the fights this session sees
   * are still counted.
   */
  private pastRecord(): Promise<FoldedRecord> {
    this.before ??= foldFile(this.file, this.priorBytes)
      .catch((error: unknown) => {
        this.events.notice?.(
          `Fight statistics could not be read from ${this.file}: ${errorMessage(error)}`
        );
        return NOTHING_FOLDED;
      })
      .then((folded) => (this.past = folded));
    return this.before;
  }
}

/** The file's length, or zero for one not there yet. */
function lengthOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Folds the first `bytes` of a log, asynchronously and in slices.
 *
 * A prefix of a gzip-member file that ends on a member boundary is itself a
 * valid stream, and the prefix an instance measured on opening ends on one:
 * every member past it is that instance's own append. The decompression
 * runs on the thread pool; the parse yields to the event loop every
 * `records.fightsFoldSlice` fights, so a socket read is never behind more
 * than one slice of it.
 */
async function foldFile(file: string, bytes: number): Promise<FoldedRecord> {
  const folds: FightFolds = new Map();
  const outputs: FightOutputs = new Map();
  if (bytes === 0) return { folds, outputs };
  const raw = Buffer.alloc(bytes);
  const handle = await fs.promises.open(file, 'r');
  let read: number;
  try {
    read = (await handle.read(raw, 0, bytes, 0)).bytesRead;
  } finally {
    await handle.close();
  }
  // `Z_SYNC_FLUSH` for the reason `readFights` gives: a truncated last member
  // is what a crash leaves, and everything before it is still the record.
  const text = await new Promise<string>((resolve, reject) => {
    zlib.gunzip(
      raw.subarray(0, read),
      { finishFlush: zlib.constants.Z_SYNC_FLUSH },
      (error, out) => (error ? reject(error) : resolve(out.toString('utf8')))
    );
  });
  const slice = tuning().records.fightsFoldSlice;
  let start = 0;
  let parsed = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    if (end > start) {
      try {
        const record = JSON.parse(text.slice(start, end)) as FightRecord;
        foldFight(folds, record);
        foldOutput(outputs, record);
      } catch {
        // One malformed line costs one fight, not the file.
      }
      parsed += 1;
      if (parsed % slice === 0) await new Promise<void>((next) => setImmediate(next));
    }
    start = end + 1;
  }
  return { folds, outputs };
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
