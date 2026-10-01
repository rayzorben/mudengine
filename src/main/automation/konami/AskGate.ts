/**
 * When the provider is paid for an ask (todo 66): not again on a clock or a
 * drift while what it would decide is unchanged, and not again at once after
 * an ask that failed. The plan in hand runs on meanwhile. Only a call to the
 * provider is held: a choice with one option is made without one.
 */
export class AskGate {
  /** Not before this is a failed ask tried again; 0 when none failed. */
  private againAt = 0;
  private failures = 0;
  /** What the last ask that made a plan decided between (`requestSubstance`). */
  private substance: string | null = null;

  constructor(private readonly retry: () => { retryMs: number; retryMaxMs: number }) {}

  /** When a held ask may go, or null when none is held. */
  heldUntil(now: number): number | null {
    return now < this.againAt ? this.againAt : null;
  }

  /** The last plan was asked over the same substance: nothing new to pay for. */
  unchanged(substance: string): boolean {
    return substance === this.substance;
  }

  /** An ask that failed: the moment it may go again, the wait doubling with each failure in a row. */
  failed(now: number): number {
    const { retryMs, retryMaxMs } = this.retry();
    this.failures += 1;
    this.againAt = now + Math.min(retryMs * 2 ** (this.failures - 1), retryMaxMs);
    return this.againAt;
  }

  /** A plan made, asked or decided here, over this substance. */
  planned(substance: string): void {
    this.failures = 0;
    this.againAt = 0;
    this.substance = substance;
  }

  /** The player's own ask and a death are not held by a failure before them. */
  release(): void {
    this.againAt = 0;
  }

  /** A new session, or the planner switched off: nothing before it holds what comes next. */
  reset(): void {
    this.againAt = 0;
    this.failures = 0;
    this.substance = null;
  }
}
