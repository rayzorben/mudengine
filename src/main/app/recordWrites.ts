/**
 * One record file's writes: in the background while the client plays, so a
 * quarter-megabyte belongings or players file is not written on the thread
 * that reads every socket (2026-11-04), and at once after `close()`, so a
 * quit still lands what it owes. One write is out at a time; text handed in
 * meanwhile waits, the newest replacing the older. `close()` writes the
 * newest text handed in at once, whether it was waiting or still out, and a
 * write that was out writes it again when it settles, so its rename cannot
 * leave the file at an older text.
 */
import { writeWhole, writeWholeSync } from './writeWhole';

export class RecordWrites {
  private writing = false;
  private waiting: string | null = null;
  /** The newest text handed in, out or waiting or written. */
  private latest: string | null = null;
  private closed = false;

  /**
   * @param failed Told when a write fails, so the store words it and stays
   *   owed: its next change writes again.
   */
  constructor(
    readonly file: string,
    private readonly failed: (error: unknown) => void
  ) {}

  /** Writes `text` whole: in the background, or at once once closed. */
  write(text: string): void {
    this.latest = text;
    if (this.closed) {
      this.now(text);
      return;
    }
    if (this.writing) {
      this.waiting = text;
      return;
    }
    this.writing = true;
    writeWhole(this.file, text, { stillWanted: () => !this.closed })
      .catch((error: unknown) => this.failed(error))
      .finally(() => {
        this.writing = false;
        // Closed while this was out: its rename may have landed after the close's.
        if (this.closed) {
          if (this.latest !== null) this.now(this.latest);
          return;
        }
        const next = this.waiting;
        this.waiting = null;
        if (next !== null) this.write(next);
      })
      // `failed` and `write` report their own failures; nothing is left to catch.
      .catch(() => undefined);
  }

  /** From now on every write is at once; one waiting or still out is written now. Safe to call twice. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const owed = this.writing || this.waiting !== null;
    this.waiting = null;
    if (owed && this.latest !== null) this.now(this.latest);
  }

  private now(text: string): void {
    try {
      writeWholeSync(this.file, text);
    } catch (error) {
      this.failed(error);
    }
  }
}
