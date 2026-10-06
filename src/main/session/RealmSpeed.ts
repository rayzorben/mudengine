/**
 * How many times faster than the server's own clocks this realm runs
 * (GreaterMUD's `GameSpeedMultiplier`: orohost 5, paramud 1), read off a
 * fight's rounds. A blow after `speedQuietMs` of quiet opens a round; a gap
 * between openings up to `speedGapMostMs` is counted, and
 * the server's round over their median, whole, is the figure once
 * `speedRounds` are seen. Before then the realm runs at the server's own
 * speed. See `mudengine-automation` › parts/loops.md › *The survey runs on the
 * realm's clocks*.
 */
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import { median } from '../../shared/median';
import { RoundBeat } from '../automation/RoundBeat';

/** The figure from the gaps between rounds, in ms: the server's round over their median, never under 1; null on too few. */
export function speedOf(
  gaps: readonly number[],
  serverRoundMs: number,
  least: number
): number | null {
  if (gaps.length < Math.max(1, least)) return null;
  const typical = median(gaps);
  if (typical === null || typical <= 0) return null;
  return Math.max(1, Math.round(serverRoundMs / typical));
}

export class RealmSpeed {
  private readonly beat = new RoundBeat(() => tuning().hunting.speedQuietMs);
  private opened: number | null = null;
  private gaps: number[] = [];

  /** Every block: a blow that opens a round times the gap from the last one. */
  onBlock(block: Pick<Block, 'type' | 'at'>): void {
    if (!this.beat.onBlock(block)) return;
    const { speedGapMostMs, speedKept } = tuning().hunting;
    if (this.opened !== null && block.at - this.opened <= speedGapMostMs) {
      this.gaps.push(block.at - this.opened);
      if (this.gaps.length > speedKept) this.gaps.splice(0, this.gaps.length - speedKept);
    }
    this.opened = block.at;
  }

  /** The realm's figure: 1 until enough rounds are seen. */
  get multiplier(): number {
    const { roundSeconds, speedRounds } = tuning().hunting;
    return speedOf(this.gaps, roundSeconds * 1000, speedRounds) ?? 1;
  }

  reset(): void {
    this.beat.reset();
    this.opened = null;
    this.gaps = [];
  }
}
