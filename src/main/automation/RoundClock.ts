/**
 * When the next round goes off, from the rounds seen. The server runs a room's
 * combat on a five-tick clock of one-second ticks (`TimedEventManager`
 * `CombatTickTime`), so a round's blows come a period apart; the period is the
 * median of recent one-round gaps (`RoundBeat`) and the phase is the last
 * round seen. Unknown until enough gaps are measured, and stale as many
 * rounds after the last one as the reader trusts. See `mudengine-automation` › parts/walking.md
 * › *A run steps in the off-rounds*.
 */
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import { median } from '../../shared/median';
import { RoundBeat } from './RoundBeat';

/** The next round, or why it cannot be told. */
export type NextRound =
  { known: true; at: number; periodMs: number } | { known: false; why: 'unmeasured' | 'stale' };

export class RoundClock {
  private readonly beat = new RoundBeat();
  private lastAt: number | null = null;
  private gaps: number[] = [];

  onBlock(block: Block): void {
    if (!this.beat.onBlock(block)) return;
    if (this.lastAt !== null) this.noteGap(block.at - this.lastAt);
    this.lastAt = block.at;
  }

  /** The first round after `now`, or stale past `trustedRounds` rounds after the last seen. */
  next(now: number, trustedRounds: number): NextRound {
    const periodMs = this.period();
    if (periodMs === null || this.lastAt === null) return { known: false, why: 'unmeasured' };
    const since = now - this.lastAt;
    if (since > periodMs * trustedRounds) return { known: false, why: 'stale' };
    const ahead = Math.floor(Math.max(0, since) / periodMs) + 1;
    return { known: true, at: this.lastAt + ahead * periodMs, periodMs };
  }

  reset(): void {
    this.beat.reset();
    this.lastAt = null;
    this.gaps = [];
  }

  private noteGap(gap: number): void {
    const nominal = tuning().hunting.roundSeconds * 1000;
    if (Math.abs(gap - nominal) > nominal * tuning().combat.oneRoundShare) return;
    this.gaps.push(gap);
    const keep = tuning().combat.roundSamples;
    if (this.gaps.length > keep) this.gaps.splice(0, this.gaps.length - keep);
  }

  private period(): number | null {
    if (this.gaps.length < tuning().combat.roundSamplesLeast) return null;
    return median(this.gaps);
  }
}
