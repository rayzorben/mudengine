/**
 * The walk's two timers, and the only ones any part of it arms: the step's
 * deadline and the hold's re-ask.
 *
 * Each is a slot, not a list, and `Walker` has always relied on that: a hold
 * that takes the walk assigns the beat outright, `reaskAfter` arms one only
 * while none is pending, and `clear` puts both down wherever a step is
 * answered or a walk ends. So the slots are one object handed to `Walker`,
 * `Holds` and `Barriers` (todo 740) rather than a timer in each, and
 * `Walker.dispose` disposes it once. See `mudengine-automation` ›
 * `parts/walking.md`.
 */
export class WalkClock {
  private step: NodeJS.Timeout | null = null;
  private hold: NodeJS.Timeout | null = null;

  /** Arms the step's deadline: the send, the answer, the prompt, an `open`. */
  afterStep(ms: number, then: () => void): void {
    this.step = setTimeout(() => {
      this.step = null;
      then();
    }, ms);
    this.step.unref?.();
  }

  /** Arms the hold's re-ask: a beat standing still, then the question again. */
  afterHold(ms: number, then: () => void): void {
    this.hold = setTimeout(() => {
      this.hold = null;
      then();
    }, ms);
    this.hold.unref?.();
  }

  /** Whether a hold's re-ask is pending. */
  get beating(): boolean {
    return this.hold !== null;
  }

  /** Puts both down. */
  clear(): void {
    if (this.hold !== null) {
      clearTimeout(this.hold);
      this.hold = null;
    }
    if (this.step === null) return;
    clearTimeout(this.step);
    this.step = null;
  }

  dispose(): void {
    this.clear();
  }
}
