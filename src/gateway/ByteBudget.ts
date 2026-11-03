/**
 * What one install may send: `perSecond` on average and `burst` at once, a
 * token bucket filled by the clock. An install over it is closed, since a
 * client keeping to the wire sends a fraction of it.
 */
export class ByteBudget {
  private left: number;
  private at: number;

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    now: number
  ) {
    this.left = burst;
    this.at = now;
  }

  /** Spend `bytes` at `now`, or say there is not enough. */
  take(bytes: number, now: number): boolean {
    this.left = Math.min(this.burst, this.left + ((now - this.at) / 1000) * this.perSecond);
    this.at = now;
    if (bytes > this.left) return false;
    this.left -= bytes;
    return true;
  }
}
