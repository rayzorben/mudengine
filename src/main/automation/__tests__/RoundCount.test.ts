import { describe, expect, it } from 'vitest';
import type { Block } from '../../../shared/blocks';
import type { RoundKind } from '../../../shared/rounds';
import { castNamed } from '../../../shared/spellcraft';
import { RoundCount } from '../RoundCount';

type Seen = [RoundKind, string, number];

/** A counter at the server's own speed (five-second rounds), the stated bash at 3.402, and what it told the lore. */
function counter(stated: number | null = 3.402) {
  const seen: Seen[] = [];
  const count = new RoundCount({
    lore: { observeRound: (kind, key, n) => seen.push([kind, key, n]) },
    speed: () => 1,
    swinging: () => (stated === null ? null : { kind: 'bash', stated }),
    fighting: () => 'gravedigger',
    spellIn: (line) => castNamed(line, ['harm', 'curse on the dead']) ?? null
  });
  return { count, seen };
}

const cast = (
  at: number,
  target = 'gravedigger',
  spell = 'harm'
): Pick<Block, 'type' | 'at' | 'groups'> => ({
  type: 'user-hits',
  at,
  groups: { attacker: 'You', target, line: `cast ${spell} at ${target}`, damage: '17' }
});
const stab = (at: number, target = 'gravedigger'): Pick<Block, 'type' | 'at' | 'groups'> => ({
  type: 'user-hits',
  at,
  groups: { attacker: 'You', target, line: `stab ${target}`, damage: '9' }
});
const lunge = (at: number, target = 'gravedigger'): Pick<Block, 'type' | 'at' | 'groups'> => ({
  type: 'user-misses',
  at,
  groups: { target }
});
const engaged = (at: number): Pick<Block, 'type' | 'at' | 'groups'> => ({
  type: 'combat-status',
  at,
  groups: {}
});

describe("counting the character's own rounds", () => {
  it('counts a round once the next opens on the same target, never the round it died in', () => {
    const { count, seen } = counter();
    count.onBlock(engaged(0));
    count.onBlock(cast(100));
    expect(seen).toEqual([]);
    count.onBlock(cast(5100));
    expect(seen).toEqual([['casts', 'harm', 1]]);
    count.onBlock(cast(5110));
    // Killed in that round: `*Combat Off*`, and the next fight's first round is another target's.
    count.onBlock(engaged(5200));
    count.onBlock(cast(10100, 'small rat'));
    count.onBlock(cast(15100, 'small rat'));
    expect(seen).toEqual([
      ['casts', 'harm', 1],
      ['casts', 'harm', 1]
    ]);
  });

  it('counts two casts in one write as one round of two, and a failed cast among them', () => {
    const { count, seen } = counter();
    count.onBlock(cast(100));
    count.onBlock({ type: 'spell-failed', at: 120, groups: { spell: 'harm' } });
    count.onBlock(cast(5100));
    expect(seen).toEqual([['casts', 'harm', 2]]);
  });

  it("counts swings, hits and misses, at the sheet's figure, but not in a fight's first round", () => {
    const { count, seen } = counter();
    for (const at of [100, 110, 120]) count.onBlock(stab(at));
    for (const at of [5100, 5110, 5120]) count.onBlock(lunge(at));
    count.onBlock(stab(5130));
    count.onBlock(stab(10100));
    // The first round opened the fight; the second is steady and lived through.
    expect(seen).toEqual([['swings', 'bash@3.402', 4]]);
  });

  it('counts no swings after a pause, nor where the sheet states none, and still counts casts', () => {
    const { count, seen } = counter(null);
    for (const at of [100, 5100, 10100]) {
      count.onBlock(stab(at));
      count.onBlock(cast(at + 10));
    }
    expect(seen).toEqual([
      ['casts', 'harm', 1],
      ['casts', 'harm', 1]
    ]);
    const late = counter();
    for (const at of [100, 20100, 25100, 30100]) late.count.onBlock(stab(at));
    // The round after the pause is a fresh start; the one after it is steady.
    expect(late.seen).toEqual([['swings', 'bash@3.402', 1]]);
  });

  it('leaves out a round at two targets, and one of more blows than the server swings', () => {
    const { count, seen } = counter();
    count.onBlock(cast(100));
    count.onBlock(cast(110, 'small rat'));
    count.onBlock(cast(5100));
    count.onBlock(cast(10100));
    expect(seen).toEqual([['casts', 'harm', 1]]);
    const merged = counter();
    merged.count.onBlock(stab(100));
    for (let i = 0; i < 8; i++) merged.count.onBlock(stab(5100 + i));
    merged.count.onBlock(stab(10100));
    merged.count.onBlock(stab(15100));
    expect(merged.seen).toEqual([['swings', 'bash@3.402', 1]]);
  });

  it('reads a spell named with `on` whole, and leaves out a round with a cast the book does not name', () => {
    const { count, seen } = counter();
    count.onBlock(cast(100, 'gravedigger', 'curse on the dead'));
    count.onBlock(cast(5100, 'gravedigger', 'curse on the dead'));
    count.onBlock(cast(5110, 'gravedigger', 'unknown words'));
    count.onBlock(cast(10100));
    count.onBlock(cast(15100));
    expect(seen).toEqual([
      ['casts', 'curse on the dead', 1],
      ['casts', 'harm', 1]
    ]);
  });
});
