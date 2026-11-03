/**
 * How often one address may ask for a challenge or register. Both are held in
 * memory under a cap that drops the oldest first, so without this one caller
 * asking fast enough would push every real client's unanswered challenge out
 * (`mostChallenges`) and, registering, every real install's token
 * (`mostInstalls`). A client registers once per gateway restart, a request
 * for the challenge and one to register, and retries on a doubling wait.
 *
 * A refusal is logged once per run of refusals from an address, so a flood
 * does not become one log line per request.
 */
import type { GatewayLimits } from './limits';
import { TokenBuckets } from './TokenBucket';
import { trimOldest } from './trimOldest';

type AskLimits = Pick<GatewayLimits, 'asksPerSecond' | 'askBurst' | 'mostAskers'>;

export class AskLimit {
  private readonly buckets: TokenBuckets;
  /** Addresses refused since they were last let through. */
  private readonly refusing = new Map<string, true>();

  constructor(
    private readonly limits: AskLimits,
    private readonly log: (line: string) => void
  ) {
    this.buckets = new TokenBuckets(limits.asksPerSecond, limits.askBurst, limits.mostAskers);
  }

  /** Whether `address` may ask now. */
  allows(address: string, now: number): boolean {
    if (this.buckets.of(address, now).take(1, now)) {
      this.refusing.delete(address);
      return true;
    }
    if (!this.refusing.has(address)) {
      this.log(`register: refusing ${address}, asking faster than the limit`);
      this.refusing.set(address, true);
      trimOldest(this.refusing, this.limits.mostAskers);
    }
    return false;
  }

  /** Seconds until an address refused now may ask again. */
  get retryAfterSeconds(): number {
    return Math.ceil(1 / this.limits.asksPerSecond);
  }
}
