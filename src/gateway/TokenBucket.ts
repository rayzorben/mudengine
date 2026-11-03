/**
 * A token bucket filled by the clock: `perSecond` on average and `burst` at
 * once. An install's bytes are spent from one (an install over it is closed,
 * since a client keeping to the wire sends a fraction of it), and an
 * address's challenge and registration requests from another (`AskLimit`).
 */
import { trimOldest } from './trimOldest';

export class TokenBucket {
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

  /** Spend `amount` at `now`, or say there is not enough. */
  take(amount: number, now: number): boolean {
    this.left = Math.min(this.burst, this.left + ((now - this.at) / 1000) * this.perSecond);
    this.at = now;
    if (amount > this.left) return false;
    this.left -= amount;
    return true;
  }
}

/**
 * A bucket per key (an install's token, an address), so a socket opened
 * again or a request asked again starts where the last left off rather than
 * with a fresh burst. At most `most` are held; past it the oldest goes first.
 */
export class TokenBuckets {
  private readonly byKey = new Map<string, TokenBucket>();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly most: number
  ) {}

  of(key: string, now: number): TokenBucket {
    const held = this.byKey.get(key);
    if (held !== undefined) return held;
    const bucket = new TokenBucket(this.perSecond, this.burst, now);
    this.byKey.set(key, bucket);
    trimOldest(this.byKey, this.most);
    return bucket;
  }
}
