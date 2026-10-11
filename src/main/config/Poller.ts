/**
 * The watch every store in this directory does, written once.
 *
 * `ConfigStore` explains at length why watching a file here means an owned
 * `setInterval` over `stat` rather than `fs.watch` or `fs.watchFile`: the first
 * loses the file the moment an editor saves by writing a temp file and renaming
 * over the target — vim, JetBrains and, in this tree, Dropbox — and the second
 * establishes its baseline with an *asynchronous* stat, so an edit landing
 * during startup is absorbed and never reported. Both failure modes are silent.
 *
 * That reasoning is not per store, so the mechanism should not be either. What
 * differs between them is only what counts as a revision: one file's size and
 * mtime, or a whole tree's listing. A signature is therefore a string the
 * caller composes, and this compares it against the one the current values were
 * actually read from — never against the previous poll, so a write racing a
 * read is picked up on the next tick instead of being mistaken for the
 * starting state.
 *
 * The poll reads asynchronously and the settle synchronously (`revision.ts`):
 * the poll runs twice a second and on a network share each listing is round
 * trips, while a settle follows a read the store just did, and an async one
 * would let an edit land between the read and the revision and be absorbed.
 * A poll in flight when a settle lands is dropped, since it read the files
 * before the settle did.
 */

import { errorMessage } from '../../shared/values';
import { tuning } from '../app/tuning';
import { revision, revisionNow, type Watched } from './revision';

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

  /** The revision the current values were read from. */
  private seen = '';
  /** Moves on every settle, so a poll that began before one is dropped. */
  private settled = 0;
  private checking = false;

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

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), tuning().files.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
  }

  /** One check. A poll that ends after `stop` schedules nothing. */
  async poll(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    const settled = this.settled;
    let now: string;
    try {
      now = await revision(this.options.watched());
    } catch (error) {
      now = unreadable(error);
    } finally {
      this.checking = false;
    }
    if (settled !== this.settled || now === this.seen || this.timer === null) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.options.reload();
    }, tuning().files.debounceMs);
    this.debounce.unref?.();
  }
}

/**
 * A store's own description throwing is not a reason to stop watching: it is
 * read as a state, as a missing file is, so the store reloads when it clears.
 */
function unreadable(error: unknown): string {
  return `unreadable:${errorMessage(error)}`;
}
