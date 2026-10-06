/**
 * How many times faster than the server's own clocks this realm runs
 * (GreaterMUD's `GameSpeedMultiplier`: orohost 5, paramud 1), read off a
 * fight's blows. A blow after `speedQuietMs` of quiet opens a round at any
 * speed; a gap between openings up to `speedGapMostMs` is counted, and the
 * server's round over their median, whole, is the figure once `speedRounds`
 * are seen; before then, the server's own speed. One per session (`Errands`),
 * read by the survey and every `RoundBeat`. See `mudengine-automation` ›
 * parts/loops.md › *The survey runs on the realm's clocks*.
 */
import { tuning } from '../app/tuning';
import type { Block, BlockType } from '../../shared/blocks';
import { median } from '../../shared/median';

/** A blow either way, hit or miss: what a round is read off. */
export function isBlow(type: BlockType): boolean {
  return (
    type === 'user-hits' || type === 'user-misses' || type === 'mob-hits' || type === 'mob-misses'
  );
}

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
  private lastBlowAt = Number.NEGATIVE_INFINITY;
  private opened: number | null = null;
  private gaps: number[] = [];
  /** The figure, worked out when a gap is counted rather than on every read. */
  private figure: number | null = null;

  /** Every block: only a blow counts. */
  onBlock(block: Pick<Block, 'type' | 'at'>): void {
    if (isBlow(block.type)) this.blow(block.at);
  }

  /** A blow at `at`: one that opens a round times the gap from the last opening. */
  blow(at: number): void {
    const { speedQuietMs, speedGapMostMs, speedKept, roundSeconds, speedRounds } = tuning().hunting;
    const opens = at - this.lastBlowAt > speedQuietMs;
    this.lastBlowAt = at;
    if (!opens) return;
    if (this.opened !== null && at - this.opened <= speedGapMostMs) {
      this.gaps.push(at - this.opened);
      if (this.gaps.length > speedKept) this.gaps.splice(0, this.gaps.length - speedKept);
      this.figure = speedOf(this.gaps, roundSeconds * 1000, speedRounds);
    }
    this.opened = at;
  }

  /** The realm's figure: 1 until enough rounds are seen. */
  get multiplier(): number {
    return this.figure ?? 1;
  }

  reset(): void {
    this.lastBlowAt = Number.NEGATIVE_INFINITY;
    this.opened = null;
    this.gaps = [];
    this.figure = null;
  }
}
