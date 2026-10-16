/**
 * Where a round's blows begin. The server prints a round's blows together on
 * the room's tick, so blows closer than `tuning.combat.roundGapMs` are one
 * round and the first after a longer quiet opens the next. On a realm that
 * runs faster than the server's own clocks (`RealmSpeed`: orohost at 5, a
 * round a second) the quiet is that much shorter, never under `speedQuietMs`;
 * at the server's own quiet a whole fight there read as one round. `CastRound`
 * reopens the round's cast with it, `RoundClock` numbers the rounds on it and
 * `RoundCount` counts the character's own in each.
 */
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import { atSpeed } from '../../shared/hunting';
import { isBlow } from './RealmSpeed';

/** A round at the realm's speed `speed`, in ms: the server's round over the figure (`atSpeed`). */
export function roundMsAt(speed: number): number {
  return atSpeed(tuning().hunting, speed).roundSeconds * 1000;
}

/** The quiet after a blow that opens the next round at the realm's speed `speed`, in ms. */
export function roundQuietMs(speed: number): number {
  return Math.max(tuning().combat.roundGapMs / speed, tuning().hunting.speedQuietMs);
}

export class RoundBeat {
  private lastBlowAt = Number.NEGATIVE_INFINITY;

  /** `speed`: the session's figure (`RealmSpeed`); the server's own where nothing reads one. */
  constructor(private readonly speed: () => number = () => 1) {}

  /** True when the block is a blow, either way and hit or miss, that opens a new round. */
  onBlock(block: Pick<Block, 'type' | 'at'>): boolean {
    if (!isBlow(block.type)) return false;
    const opens = block.at - this.lastBlowAt > roundQuietMs(this.speed());
    this.lastBlowAt = block.at;
    return opens;
  }

  /** A round at the realm's speed, in ms (`roundMsAt`). */
  get roundMs(): number {
    return roundMsAt(this.speed());
  }

  reset(): void {
    this.lastBlowAt = Number.NEGATIVE_INFINITY;
  }
}
