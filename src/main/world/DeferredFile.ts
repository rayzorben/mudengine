import { RecordWrites } from '../app/recordWrites';
import { tuning } from '../app/tuning';

/**
 * A record file written a while after it changes, whole and in the
 * background (`RecordWrites`), and at once by `close()`. A failed write stays
 * owed, so the next change tries again rather than the failure becoming
 * permanent.
 */
export class DeferredFile {
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private readonly writes: RecordWrites;

  /**
   * @param payload What to write, read when the write happens.
   * @param onFailure Told when a write fails; the store words it.
   */
  constructor(
    readonly file: string,
    private readonly payload: () => unknown,
    private readonly onFailure: (error: unknown) => void
  ) {
    this.writes = new RecordWrites(file, (error) => {
      this.dirty = true;
      onFailure(error);
    });
  }

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
    this.writes.close();
    if (this.dirty) this.write();
  }

  private write(): void {
    let text: string;
    try {
      text = `${JSON.stringify(this.payload(), null, 2)}\n`;
    } catch (error) {
      this.onFailure(error);
      return;
    }
    this.dirty = false;
    this.writes.write(text);
  }
}
