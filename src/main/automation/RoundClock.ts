/**
 * When the next round goes off, from the rounds seen. The server's rounds keep
 * one beat for a whole connection (five one-second ticks, `TimedEventManager`
 * `CombatTickTime`), so every round seen is numbered on that beat and the
 * beat is a line fitted through the last `roundSamples` of them: the period
 * its slope, once known to `roundPeriodSureMs`, `hunting.roundSeconds` until
 * then. A round's first blow lands 250 ms from the beat at the median and
 * 470 ms at p90, so no single round sets it. Rounds off the beat in a row
 * (`offBeatRounds`) start a new one. See `mudengine-automation` ›
 * parts/walking.md › *A run steps in the off-rounds*.
 */
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import { RoundBeat } from './RoundBeat';

/** The next round, or that none has been seen to count from. */
export type NextRound = { known: true; at: number; periodMs: number } | { known: false };

/** A round seen, numbered on the beat. */
type Seen = { readonly at: number; readonly n: number };

/** The beat: round `n` goes off at `zero + n × periodMs`. */
type Beat = { readonly zero: number; readonly periodMs: number };

/**
 * The beat through `seen`: the least-squares period when its standard error
 * is within `sureMs`, otherwise `nominalMs`, with the phase the mean of the
 * rounds against that period. Times are taken from the first round so the
 * sums stay small.
 */
export function fitBeat(seen: readonly Seen[], nominalMs: number, sureMs: number): Beat {
  const base = seen[0]!;
  const xs = seen.map((s) => s.n - base.n);
  const ys = seen.map((s) => s.at - base.at);
  const count = seen.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / count;
  const meanY = ys.reduce((a, b) => a + b, 0) / count;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < count; i++) {
    sxx += (xs[i]! - meanX) ** 2;
    sxy += (xs[i]! - meanX) * (ys[i]! - meanY);
  }
  let periodMs = nominalMs;
  if (count > 2 && sxx > 0) {
    const slope = sxy / sxx;
    let ssr = 0;
    for (let i = 0; i < count; i++) ssr += (ys[i]! - meanY - slope * (xs[i]! - meanX)) ** 2;
    if (Math.sqrt(ssr / (count - 2) / sxx) <= sureMs) periodMs = slope;
  }
  return { zero: base.at + meanY - periodMs * (meanX + base.n), periodMs };
}

export class RoundClock {
  private readonly beat = new RoundBeat();
  /** The latest rounds on the beat, oldest first. */
  private seen: Seen[] = [];
  /** Rounds off the beat since the last one on it. */
  private off: number[] = [];
  private fitted: Beat | null = null;

  onBlock(block: Block): void {
    if (this.beat.onBlock(block)) this.note(block.at);
  }

  /** The first round after `now` on the beat, never the slot of a round already seen. */
  next(now: number): NextRound {
    const beat = this.fitted;
    const latest = this.seen.at(-1);
    if (beat === null || latest === undefined) return { known: false };
    const ahead = Math.max(Math.floor((now - beat.zero) / beat.periodMs) + 1, latest.n + 1);
    return { known: true, at: beat.zero + ahead * beat.periodMs, periodMs: beat.periodMs };
  }

  reset(): void {
    this.beat.reset();
    this.seen = [];
    this.off = [];
    this.fitted = null;
  }

  private note(at: number): void {
    const beat = this.fitted;
    if (beat === null) return this.restart([at]);
    const place = (at - beat.zero) / beat.periodMs;
    const n = Math.round(place);
    const { offBeatShare, offBeatRounds, roundSamples } = tuning().combat;
    if (Math.abs(place - n) > offBeatShare) {
      this.off.push(at);
      if (this.off.length >= offBeatRounds) this.restart(this.off);
      return;
    }
    this.off = [];
    this.seen.push({ at, n });
    if (this.seen.length > roundSamples) this.seen.splice(0, this.seen.length - roundSamples);
    this.refit();
  }

  /** A new beat from `rounds`, numbered at the nominal period. */
  private restart(rounds: readonly number[]): void {
    const nominal = tuning().hunting.roundSeconds * 1000;
    const first = rounds[0]!;
    this.seen = rounds.map((at) => ({ at, n: Math.round((at - first) / nominal) }));
    this.off = [];
    this.refit();
  }

  private refit(): void {
    const { roundPeriodSureMs } = tuning().combat;
    this.fitted = fitBeat(this.seen, tuning().hunting.roundSeconds * 1000, roundPeriodSureMs);
  }
}
