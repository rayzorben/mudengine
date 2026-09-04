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
 */

import { tuning } from '../app/tuning';

export interface PollerOptions {
  /**
   * Identifies what is on disk right now. Cheap: it runs twice a second.
   *
   * Must describe everything a reload would notice — for a tree that means a
   * file appearing or disappearing as well as one changing, or a deleted
   * character would go on being offered until the next restart.
   */
  signature(): string;
  /** Re-read. Called after the debounce, never during construction. */
  reload(): void;
}

export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;

  /** The revision the current values were read from. */
  private seen = '';

  constructor(private readonly options: PollerOptions) {}

  /** Records what the caller has just read, so the next poll compares to it. */
  settle(): void {
    this.seen = this.safeSignature();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), tuning().files.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
  }

  /** One check. Exposed so a test need not wait out an interval. */
  poll(): void {
    if (this.safeSignature() === this.seen) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.options.reload();
    }, tuning().files.debounceMs);
    this.debounce.unref?.();
  }

  /**
   * A signature that throws is not a reason to stop watching.
   *
   * A directory can be removed and put back — that is what a sync client does
   * to one — and a watcher that died the first time it happened would leave the
   * client reporting values nobody can change any more.
   */
  private safeSignature(): string {
    try {
      return this.options.signature();
    } catch {
      return 'unreadable';
    }
  }
}
