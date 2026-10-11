/**
 * Rows a character's record is written in batches of (todo 26): held and
 * capped, dropping the oldest, written on one unref'd timer and once on the
 * way out, and a write that throws said once and then let alone. `FightLog`
 * and `HarmLog` both write through one. `mudengine-world` › *Every fight is
 * written down before anybody asks* has why the write is synchronous.
 */
import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';

export interface HeldRowsParts<T> {
  /** The character's record, named in the notice. */
  dir: string;
  /**
   * Writes the rows, throwing when it cannot; false when it may not yet (the
   * rows stay held and the timer runs again). `final` is the write on the way out.
   */
  write(rows: readonly T[], final: boolean): boolean;
  notice?(message: string): void;
}

export class HeldRows<T> {
  private held: T[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Reported once. A directory that will not open will not open again either. */
  private complained = false;

  constructor(private readonly parts: HeldRowsParts<T>) {}

  hold(row: T): void {
    this.held.push(row);
    if (this.held.length > tuning().records.fightsHeld) this.held.shift();
    this.schedule();
  }

  /** Writes what is held now: on the way out, or when a reader needs the file. */
  flush(): void {
    this.write(true);
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

  private write(final: boolean): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.held.length === 0) return;
    // Cleared before the write: a write that throws has been reported, and a
    // retry would retry on every later flush against a path that stays broken.
    const rows = this.held;
    this.held = [];
    try {
      if (this.parts.write(rows, final)) return;
      this.held = [...rows, ...this.held].slice(-tuning().records.fightsHeld);
      this.schedule();
    } catch (error) {
      if (this.complained) return;
      this.complained = true;
      this.parts.notice?.(
        t('notices.fights.unwritable', { dir: this.parts.dir, error: errorMessage(error) })
      );
    }
  }
}
