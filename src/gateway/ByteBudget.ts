/**
 * What one install may send: `perSecond` on average and `burst` at once, a
 * token bucket filled by the clock. An install over it is closed, since a
 * client keeping to the wire sends a fraction of it.
 */
import { trimOldest } from './trimOldest';

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

/**
 * Each install's budget, by token, so a socket opened again starts where the
 * last one left off rather than with a fresh burst. As many as there are
 * installs held (`mostInstalls`); past it the oldest goes first.
 */
export class ByteBudgets {
  private readonly byToken = new Map<string, ByteBudget>();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly most: number
  ) {}

  of(token: string, now: number): ByteBudget {
    const held = this.byToken.get(token);
    if (held !== undefined) return held;
    const budget = new ByteBudget(this.perSecond, this.burst, now);
    this.byToken.set(token, budget);
    trimOldest(this.byToken, this.most);
    return budget;
  }
}
