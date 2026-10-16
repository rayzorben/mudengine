/**
 * The watch every store in this directory does, written once
 * (`mudengine-config` › *Configuration is YAML, watched, hot-reloaded*).
 *
 * Two ways in, one test. `fs.watch` on each directory a store's files sit in
 * (never on a file, which an atomic save's rename leaves behind) nudges a
 * check at once where the disk gives notification; an owned `setInterval`
 * every `files.pollIntervalMs` is the fallback for a share that gives none
 * (Azure Files). Either way a reload happens only when the revision differs
 * from the one the values were read from, so the store's own write, settled
 * after it lands by stamping that one file, is not read back. The poll reads asynchronously and a
 * settle synchronously (`revision.ts`); a poll in flight across a settle is
 * dropped, since it read the files first.
 */
import { watch, type FSWatcher } from 'node:fs';

import { errorMessage } from '../../shared/values';
import { tuning } from '../app/tuning';
import {
  directoriesOf,
  revision,
  revisionNow,
  spell,
  stampNow,
  type Revision,
  type Watched
} from './revision';

export interface PollerOptions {
  /**
   * What is on disk for this store. Must cover everything a reload would
   * notice: for a tree that means a file appearing or disappearing as well
   * as one changing, or a deleted character would go on being offered until
   * the next restart.
   */
  watched(): readonly Watched[];
  /** Re-read. Called after the debounce, never during construction. */
  reload(): void;
}

export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;

  /** The revision the current values were read from, path by path. */
  private seen: Revision = new Map();
  /** Moves on every settle, so a poll that began before one is dropped. */
  private settled = 0;
  private checking = false;
  /** One change notification per directory, by directory. */
  private readonly watchers = new Map<string, FSWatcher>();
  /** The revision the watchers were opened for; a new one may add a directory. */
  private watchedAt: string | null = null;
  /** Moves on every rewatch and on `stop`, so a stale rewatch opens nothing. */
  private rewatches = 0;
  /** A notification's check, waiting out the burst an editor's save makes. */
  private nudge: NodeJS.Timeout | null = null;

  constructor(private readonly options: PollerOptions) {}

  /** Records what the caller has just read, so the next poll compares to it. */
  settle(): void {
    this.settled += 1;
    try {
      this.seen = revisionNow(this.options.watched());
    } catch (error) {
      this.seen = unreadable(error);
    }
  }

  /**
   * Records the store's own write of one file: one `stat`, never a listing,
   * since on a network share a listing is the stall (`revision.ts`). Every
   * other path keeps the stamp it was read at, so a hand edit to another of
   * the store's files is still reloaded.
   */
  settleFile(file: string): void {
    this.settled += 1;
    const stamped = stampNow(file);
    if (stamped === null) this.seen.delete(file);
    else this.seen.set(file, stamped);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), tuning().files.pollIntervalMs);
    this.timer.unref?.();
    try {
      void this.rewatch(this.options.watched());
    } catch {
      // The store cannot say yet; the first check that can opens the watch.
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    if (this.nudge) clearTimeout(this.nudge);
    this.timer = null;
    this.debounce = null;
    this.nudge = null;
    this.rewatches += 1;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.watchedAt = null;
  }

  /** One check. A poll that ends after `stop` schedules nothing. */
  async poll(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    const settled = this.settled;
    let now: Revision;
    let watched: readonly Watched[] | null = null;
    try {
      watched = this.options.watched();
      now = await revision(watched);
    } catch (error) {
      now = unreadable(error);
    } finally {
      this.checking = false;
    }
    if (this.timer === null) return;
    const spelled = spell(now);
    if (watched !== null && spelled !== this.watchedAt) {
      this.watchedAt = spelled;
      void this.rewatch(watched);
    }
    if (settled !== this.settled || spelled === spell(this.seen)) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.options.reload();
    }, tuning().files.debounceMs);
    this.debounce.unref?.();
  }

  /** A notification for one of this store's names: a check after the debounce. */
  private nudged(): void {
    if (this.nudge !== null || this.timer === null) return;
    this.nudge = setTimeout(() => {
      this.nudge = null;
      // A check already out may have read before this change; ask again after it.
      if (this.checking) this.nudged();
      else void this.poll();
    }, tuning().files.debounceMs);
    this.nudge.unref?.();
  }

  /**
   * Opens a watch on each directory the store's files sit in and closes the
   * ones it no longer needs. A directory that cannot be watched (missing, or a
   * share with no notification) is left to the poll; a watch that errors, as
   * one on a deleted character's directory does, is closed and reopened if the
   * directory comes back.
   */
  private async rewatch(watched: readonly Watched[]): Promise<void> {
    const turn = ++this.rewatches;
    let wanted: Map<string, (name: string) => boolean>;
    try {
      wanted = await directoriesOf(watched);
    } catch {
      // A description that throws midway reads as unreadable to the poll too,
      // which goes on checking; the next changed revision tries again.
      this.watchedAt = null;
      return;
    }
    if (turn !== this.rewatches || this.timer === null) return;
    for (const [dir, watcher] of this.watchers) {
      if (wanted.has(dir)) continue;
      watcher.close();
      this.watchers.delete(dir);
    }
    let opened = false;
    for (const [dir, accept] of wanted) {
      if (this.watchers.has(dir)) continue;
      let watcher: FSWatcher;
      try {
        watcher = watch(dir, { persistent: false }, (_event, name) => {
          if (name === null || accept(String(name))) this.nudged();
        });
      } catch {
        continue;
      }
      watcher.on('error', () => {
        watcher.close();
        if (this.watchers.get(dir) === watcher) this.watchers.delete(dir);
        this.watchedAt = null;
      });
      this.watchers.set(dir, watcher);
      opened = true;
    }
    // An edit landing before a watch was open sent it nothing: one check covers it.
    if (opened) this.nudged();
  }
}

/**
 * A store's own description throwing is not a reason to stop watching: it is
 * read as a state, as a missing file is, so the store reloads when it clears.
 */
function unreadable(error: unknown): Revision {
  return new Map([['', `unreadable:${errorMessage(error)}`]]);
}
