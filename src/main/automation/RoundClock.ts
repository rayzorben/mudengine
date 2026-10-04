/**
 * When the next round goes off, from the rounds seen. The server runs a room's
 * combat on a five-tick clock of one-second ticks (`TimedEventManager`
 * `CombatTickTime`), so a round's blows come a period apart. The period is
 * `hunting.roundSeconds` until enough one-round gaps are measured
 * (`RoundBeat`), then their median, worked out once per round seen. The phase
 * is the last round seen, and every round seen resets it. Unknown only until
 * the first round. See `mudengine-automation` › parts/walking.md › *A run
 * steps in the off-rounds*.
 */
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import { median } from '../../shared/median';
import { RoundBeat } from './RoundBeat';

/** The next round, or that none has been seen to count from. */
export type NextRound = { known: true; at: number; periodMs: number } | { known: false };

export class RoundClock {
  private readonly beat = new RoundBeat();
  private lastAt: number | null = null;
  private gaps: number[] = [];
  /** The measured round, or null while there are too few gaps. */
  private measuredMs: number | null = null;

  onBlock(block: Block): void {
    if (!this.beat.onBlock(block)) return;
    if (this.lastAt !== null) this.noteGap(block.at - this.lastAt);
    this.lastAt = block.at;
  }

  /** The first round after `now`, counted on from the last round seen. */
  next(now: number): NextRound {
    if (this.lastAt === null) return { known: false };
    const periodMs = this.measuredMs ?? tuning().hunting.roundSeconds * 1000;
    const since = now - this.lastAt;
    const ahead = Math.floor(Math.max(0, since) / periodMs) + 1;
    return { known: true, at: this.lastAt + ahead * periodMs, periodMs };
  }

  reset(): void {
    this.beat.reset();
    this.lastAt = null;
    this.gaps = [];
    this.measuredMs = null;
  }

  private noteGap(gap: number): void {
    const nominal = tuning().hunting.roundSeconds * 1000;
    if (Math.abs(gap - nominal) > nominal * tuning().combat.oneRoundShare) return;
    this.gaps.push(gap);
    const keep = tuning().combat.roundSamples;
    if (this.gaps.length > keep) this.gaps.splice(0, this.gaps.length - keep);
    if (this.gaps.length >= tuning().combat.roundSamplesLeast) this.measuredMs = median(this.gaps);
  }
}
