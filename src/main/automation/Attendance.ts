/**
 * Whether anybody is at the keyboard for this character: MegaMUD's AFK mode,
 * as a fact rather than a switch (todo 79).
 *
 * Away is no key pressed into this session for `automation.afk.afterMinutes`.
 * Every keystroke counts, so the first key ends it (`AutoAfkOff`); the clock
 * starts at realm entry, so a character autoconnect logged in and nobody
 * touched is away like any other. Automation's own commands never count: a
 * loop walking all night is the case this exists for. The telepath reply
 * (`Afk`) and the hang-up (`Safety`) read it, and the trace carries it to the
 * window (`AutomationSnapshot.away`), so `changed` runs when it flips either
 * way. See `mudengine-automation` › `parts/remotes.md`.
 */
import type { SessionModule } from './Module';

export class Attendance implements SessionModule {
  /** When a key was last pressed here, or the realm entered. Null before either. */
  private at: number | null = null;
  /** The flip to away, owned so a reset or a key puts it down. */
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private afterMinutes: number,
    private readonly changed: () => void = () => undefined,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Reloaded configuration: `automation.afk.afterMinutes`. */
  configure(afterMinutes: number): void {
    if (afterMinutes === this.afterMinutes) return;
    const was = this.away;
    this.afterMinutes = afterMinutes;
    this.arm(was);
  }

  /** The player pressed a key in this session, or the character entered the realm. */
  note(): void {
    const was = this.away;
    this.at = this.now();
    this.arm(was);
  }

  reset(): void {
    const was = this.away;
    this.at = null;
    this.arm(was);
  }

  dispose(): void {
    this.disarm();
  }

  /** Nobody has pressed a key for `afterMinutes`. False before the realm: nothing has started the clock. */
  get away(): boolean {
    return this.at !== null && this.now() - this.at >= this.afterMinutes * 60_000;
  }

  /** Says a flip that already happened, and times the next one. */
  private arm(was: boolean): void {
    this.disarm();
    if (was !== this.away) this.changed();
    if (this.at === null || this.away) return;
    const left = this.at + this.afterMinutes * 60_000 - this.now();
    // Armed again rather than trusted: a timer may fire a millisecond early.
    this.timer = setTimeout(() => this.arm(false), left);
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
