/**
 * Every fight this character has been in, written down, and what the record
 * says about a monster or about the character's own damage.
 *
 * The record is `fights/<id>/`, segments of appended gzip members with each
 * closed segment's fold beside it (`fightSegments.ts`). A flush appends one
 * member, synchronously, and never blocks the parse path: `record` pushes and
 * returns. What is held is capped, dropping the oldest, and a directory that
 * cannot be written is said once and then let alone; a statistics file never
 * costs a character its connection. `mudengine-world` › *Every fight is
 * written down before anybody asks* has the reasons and the measurements.
 */
import { errorMessage } from '../../shared/values';
import {
  AS_PRINTED,
  foldFight,
  foldOutput,
  measuredPerRound,
  mergeFolds,
  mergeOutputs,
  summarizeFolds,
  type FightFolds,
  type FightOutputs,
  type FightRecord,
  type FightSink,
  type FightSummary,
  type MeasureAsk,
  type MeasuredOutput,
  type MobResolver
} from '../../shared/fights';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import {
  appendFights,
  closedFold,
  emptyFold,
  fightsPerSegment,
  foldSegment,
  lengthOf,
  segmentFile,
  segmentsIn,
  type FoldedRecord
} from './fightSegments';

export interface FightLogEvents {
  /** Said into the terminal: a record that cannot be written or read, a fold made again. */
  notice?(message: string): void;
}

/** The record as it stood when this log first touched it. */
interface Before {
  closed: readonly number[];
  open: number;
  /** The open segment's length then: past it is this log's own, already in `recorded`. */
  openBytes: number;
}

/** The segment a flush appends to, and how many fights it holds when that is known. */
interface Open {
  segment: number;
  fights: number | null;
}

export class FightLog implements FightSink {
  private held: FightRecord[] = [];
  /** Every fight this instance has recorded, folded as it happened. */
  private readonly recorded: FightFolds = new Map();
  /** And what this character dealt in them, per level. */
  private readonly recordedOutput: FightOutputs = new Map();
  private start: Before | null = null;
  private open: Open | null = null;
  /** Fights appended to the open segment while its count was still unknown. */
  private uncounted = 0;
  /** The record before this instance, folded once and off the thread. See `pastRecord`. */
  private before: Promise<FoldedRecord> | null = null;
  /** The same, once it has arrived: `measured` is asked synchronously. */
  private past: FoldedRecord | null = null;
  private readonly settled: Promise<void>;
  private timer: NodeJS.Timeout | null = null;
  /** Reported once. A directory that will not open will not open again either. */
  private complained = false;

  /**
   * @param dir The character's record, created on first write.
   * @param after What must finish before the record is touched: the startup
   *   migration of an older layout. Never rejects. Until it settles fights are
   *   held, and quitting writes them anyway.
   */
  constructor(
    private readonly dir: string,
    private readonly events: FightLogEvents = {},
    after?: Promise<void>
  ) {
    if (after === undefined) {
      this.take();
      this.settled = Promise.resolve();
    } else {
      this.settled = after.then(() => this.take());
    }
  }

  record(fight: FightRecord): void {
    this.held.push(fight);
    foldFight(this.recorded, fight);
    foldOutput(this.recordedOutput, fight);
    if (this.held.length > tuning().records.fightsHeld) this.held.shift();
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write(false);
    }, tuning().records.fightFlushMs);
    // Never a reason to keep the process alive: `teardown()` writes what is held.
    this.timer.unref?.();
  }

  /** Writes what is held. Called on a timer, and once on the way out. */
  flush(): void {
    this.write(true);
  }

  private write(final: boolean): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.held.length === 0) return;
    if (this.open === null) {
      // The migration has not finished. Quitting writes anyway, and the next
      // launch's migration places what it wrote after the older record.
      if (!final) return this.schedule();
      this.take();
    }
    // Cleared before the write: a write that throws has been reported, and a
    // retry would retry on every later flush against a path that stays broken.
    let rest = this.held;
    this.held = [];
    const perSegment = fightsPerSegment();
    // A count not known yet is learned from folding the record, which a log
    // nobody asks (a probe's) would otherwise never do.
    if (this.open?.fights === null) void this.pastRecord();
    try {
      while (rest.length > 0) {
        const open = this.open as Open;
        if (open.fights !== null && open.fights >= perSegment) {
          this.close(open.segment);
          continue;
        }
        const room = open.fights === null ? rest.length : perSegment - open.fights;
        appendFights(this.dir, open.segment, rest.slice(0, room));
        const wrote = Math.min(room, rest.length);
        if (open.fights === null) this.uncounted += wrote;
        else open.fights += wrote;
        rest = rest.slice(room);
      }
    } catch (error) {
      if (this.complained) return;
      this.complained = true;
      this.events.notice?.(
        t('notices.fights.unwritable', { dir: this.dir, error: errorMessage(error) })
      );
    }
  }

  /** Starts the next segment and saves the fold of the one just closed, off the thread. */
  private close(segment: number): void {
    this.open = { segment: segment + 1, fights: 0 };
    void closedFold(this.dir, segment, (error) => this.unsaved(segment, error)).catch(
      (error: unknown) => this.cannotRead(segmentFile(this.dir, segment), error)
    );
  }

  private unsaved(segment: number, error: unknown): void {
    this.events.notice?.(
      t('notices.fights.unfolded', {
        file: segmentFile(this.dir, segment),
        error: errorMessage(error)
      })
    );
  }

  /** Reads where the record stands. Synchronous and cheap: a listing and a stat. */
  private take(): void {
    if (this.open !== null) return;
    let segments: number[] = [];
    try {
      segments = segmentsIn(this.dir);
    } catch (error) {
      this.events.notice?.(
        t('notices.fights.unreadable', { dir: this.dir, error: errorMessage(error) })
      );
    }
    const open = segments.at(-1) ?? 1;
    this.start = {
      closed: segments.slice(0, -1),
      open,
      openBytes: lengthOf(segmentFile(this.dir, open))
    };
    this.open = { segment: open, fights: segments.length === 0 ? 0 : null };
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

  /** Several names against one record, which is read once per instance. */
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
   * Synchronous, because the survey is: until the record has been folded this
   * answers from this session's fights alone and starts the fold, and
   * `ready()` is what a caller that can wait awaits first.
   */
  measured(level: number, ask: MeasureAsk): MeasuredOutput | null {
    if (this.past === null) void this.pastRecord();
    return measuredPerRound(
      [this.past?.outputs ?? emptyFold().outputs, this.recordedOutput],
      level,
      ask
    );
  }

  /** Resolves once the record as it stood has been folded. */
  async ready(): Promise<void> {
    await this.pastRecord();
  }

  /**
   * The record before this instance, folded: each closed segment's saved fold
   * (refolded where it is missing or stale), then the open segment's prefix.
   * One segment is in memory at a time. A segment that cannot be read is said
   * once and counts as empty, so the rest of the record still answers.
   */
  private pastRecord(): Promise<FoldedRecord> {
    this.before ??= this.settled.then(() => this.foldPast()).then((folded) => (this.past = folded));
    return this.before;
  }

  private async foldPast(): Promise<FoldedRecord> {
    const { closed, open, openBytes } = this.start as Before;
    const into = emptyFold();
    const add = (folded: FoldedRecord): void => {
      mergeFolds(into.folds, folded.folds);
      mergeOutputs(into.outputs, folded.outputs);
      into.fights += folded.fights;
    };
    let refolded = 0;
    for (const segment of closed) {
      try {
        const { folded, refolded: again } = await closedFold(this.dir, segment, (error) =>
          this.unsaved(segment, error)
        );
        add(folded);
        if (again) refolded += 1;
      } catch (error) {
        this.cannotRead(segmentFile(this.dir, segment), error);
      }
    }
    if (refolded > 0) {
      const params = { dir: this.dir, count: refolded };
      this.events.notice?.(
        refolded === 1
          ? t('notices.fights.refolded.one', params)
          : t('notices.fights.refolded.many', params)
      );
    }
    let openFights = 0;
    try {
      const folded = await foldSegment(segmentFile(this.dir, open), openBytes);
      add(folded);
      openFights = folded.fights;
    } catch (error) {
      this.cannotRead(segmentFile(this.dir, open), error);
    }
    if (this.open?.segment === open && this.open.fights === null) {
      this.open.fights = openFights + this.uncounted;
    }
    return into;
  }

  private cannotRead(file: string, error: unknown): void {
    this.events.notice?.(
      t('notices.fights.unreadableSegment', { file, error: errorMessage(error) })
    );
  }
}
