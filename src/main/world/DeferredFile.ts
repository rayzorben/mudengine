import { tuning } from '../app/tuning';
import { writeWholeSync } from '../app/writeWhole';

/**
 * A record file written a while after it changes, whole (`writeWholeSync`),
 * and at once by `close()`. A failed write stays owed, so the next
 * change tries again rather than the failure becoming permanent.
 */
export class DeferredFile {
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  /**
   * @param payload What to write, read when the write happens.
   * @param onFailure Told when a write fails; the store words it.
   */
  constructor(
    readonly file: string,
    private readonly payload: () => unknown,
    private readonly onFailure: (error: unknown) => void
  ) {}

  /** Something changed: write it after `records.memoryWriteDelayMs`. */
  schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, tuning().records.memoryWriteDelayMs);
    // Nothing here holds the app open; `close()` is what guarantees a landing.
    this.timer.unref?.();
  }

  /** Writes anything outstanding and stops the timer. Safe to call twice. */
  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.dirty) this.write();
  }

  private write(): void {
    try {
      writeWholeSync(this.file, `${JSON.stringify(this.payload(), null, 2)}\n`);
      this.dirty = false;
    } catch (error) {
      this.onFailure(error);
    }
  }
}
