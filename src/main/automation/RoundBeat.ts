/**
 * Where a round's blows begin. The server prints a round's blows together on
 * the room's tick, so blows closer than `tuning.combat.roundGapMs` are one
 * round and the first after a longer quiet opens the next. `CastRound` reopens
 * the round's cast with it, and `FightHeal` counts the blows taken by it.
 */
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';

export class RoundBeat {
  private lastBlowAt = Number.NEGATIVE_INFINITY;

  /** `quietMs`: the gap that opens a round; `combat.roundGapMs` but where a reader needs one that holds at any speed. */
  constructor(private readonly quietMs: () => number = () => tuning().combat.roundGapMs) {}

  /** True when the block is a blow, either way and hit or miss, that opens a new round. */
  onBlock(block: Pick<Block, 'type' | 'at'>): boolean {
    switch (block.type) {
      case 'user-hits':
      case 'user-misses':
      case 'mob-hits':
      case 'mob-misses':
        return this.blow(block.at);
      default:
        return false;
    }
  }

  private blow(at: number): boolean {
    const opens = at - this.lastBlowAt > this.quietMs();
    this.lastBlowAt = at;
    return opens;
  }

  reset(): void {
    this.lastBlowAt = Number.NEGATIVE_INFINITY;
  }
}
