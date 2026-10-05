/**
 * Deletes session logs and captures not written to in `logging.keepDays`
 * (todo 04, 2026-10-05: six weeks of play had filled 5.6 GB, captures most of
 * it). Swept at launch and every `records.logSweepEveryMs` (a day) after;
 * `0` keeps everything. Never on a settings save, where a half-typed number
 * would delete what the finished one keeps.
 *
 * Only names `isSessionRecord` accepts are touched, since `logging.directory`
 * may name a folder that holds other files. Age is the last write, never the
 * name's stamp, so a session still being written is never old.
 */
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { isSessionRecord } from './filename';
import { DAY_MS, errorMessage } from '../../shared/values';

/** Where the logs are and how long they stay, read at each sweep. */
export interface LogKeeping {
  directory: string;
  keepDays: number;
}

export interface LogSweepOptions {
  keeping(): LogKeeping;
  /** A sweep that deleted something, and one that could not. */
  notice(message: string, level: 'log' | 'warn'): void;
  now?: () => number;
}

/** What one sweep did. */
export interface Swept {
  deleted: number;
  /** The first file that could not be deleted and why, with how many could not. */
  failed: { count: number; first: string } | null;
}

/**
 * Deletes every session record in `directory` last written more than
 * `keepDays` days before `now`, stopping between files once `stopped` says
 * so. A missing directory has nothing to sweep.
 */
export async function sweepLogs(
  directory: string,
  keepDays: number,
  now: number,
  stopped: () => boolean = () => false
): Promise<Swept> {
  const swept: Swept = { deleted: 0, failed: null };
  if (keepDays <= 0) return swept;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return swept;
    throw error;
  }
  const before = now - keepDays * DAY_MS;
  for (const entry of entries) {
    if (stopped()) break;
    if (!entry.isFile() || !isSessionRecord(entry.name)) continue;
    const file = path.join(directory, entry.name);
    try {
      if ((await fs.stat(file)).mtimeMs >= before) continue;
      await fs.rm(file, { force: true });
      swept.deleted += 1;
    } catch (error) {
      const count = (swept.failed?.count ?? 0) + 1;
      swept.failed = { count, first: swept.failed?.first ?? `${file}: ${errorMessage(error)}` };
    }
  }
  return swept;
}

/** The longest delay `setTimeout` keeps: a signed 32-bit count of milliseconds. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

export class LogSweep {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private next: Promise<void> | null = null;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly options: LogSweepOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Sweeps now and every `records.logSweepEveryMs` after. A second call does nothing. */
  start(): void {
    if (this.timer !== null || this.disposed) return;
    void this.sweep();
    this.arm();
  }

  /** Sweeps now, or once more after the sweep under way; resolves when that one is done. */
  sweep(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.current === null) {
      this.current = this.run().finally(() => {
        this.current = null;
      });
      return this.current;
    }
    // Either way the sweep under way ends: its own failure is its caller's.
    const after = (): Promise<void> => {
      this.next = null;
      return this.sweep();
    };
    this.next ??= this.current.then(after, after);
    return this.next;
  }

  /** Stops the clock, and a sweep under way at its next file. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Re-armed per tick, so a changed period is picked up on the next one. Held
   * under Node's longest timer: past about 24.8 days a delay is taken as 1ms,
   * and a monthly sweep would rescan the folder a thousand times a second.
   */
  private arm(): void {
    const every = Math.min(tuning().records.logSweepEveryMs, LONGEST_TIMER_MS);
    this.timer = setTimeout(() => {
      void this.sweep();
      this.arm();
    }, every);
  }

  private async run(): Promise<void> {
    const { directory, keepDays } = this.options.keeping();
    let swept: Swept;
    try {
      swept = await sweepLogs(directory, keepDays, this.now(), () => this.disposed);
    } catch (error) {
      const said = t('app.logs.unreadable', { directory, error: errorMessage(error) });
      this.options.notice(said, 'warn');
      return;
    }
    const { deleted, failed } = swept;
    if (deleted > 0) {
      const params = { count: deleted, days: keepDays, directory };
      const said =
        deleted === 1 ? t('app.logs.swept.one', params) : t('app.logs.swept.many', params);
      this.options.notice(said, 'log');
    }
    if (failed !== null) {
      const said =
        failed.count === 1
          ? t('app.logs.notDeleted.one', failed)
          : t('app.logs.notDeleted.many', failed);
      this.options.notice(said, 'warn');
    }
  }
}
