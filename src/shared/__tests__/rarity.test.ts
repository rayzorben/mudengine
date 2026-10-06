import { describe, expect, it } from 'vitest';

import { DEFAULT_INTERNAL } from '../internal';
import { bandOf, itemRarity, type RaritySource } from '../rarity';

const bounds = DEFAULT_INTERNAL.tuning.rarity;
const drop = (hours: number | null, monster = 'orc'): RaritySource => ({
  hours,
  from: { kind: 'drop', monster, percent: 10 }
});
const quest: RaritySource = {
  hours: null,
  from: { kind: 'say', rooms: ['1/2'], say: 'pray', gate: { kind: 'quest' }, copies: 1 }
};

describe('bandOf', () => {
  it('reads each band up to, not including, its bound', () => {
    expect(bandOf(0.5, bounds)).toBe('common');
    expect(bandOf(1, bounds)).toBe('uncommon');
    expect(bandOf(23.9, bounds)).toBe('uncommon');
    expect(bandOf(24, bounds)).toBe('rare');
    expect(bandOf(168, bounds)).toBe('veryRare');
    expect(bandOf(720, bounds)).toBe('extremelyRare');
  });
});

describe('itemRarity', () => {
  it('takes the quickest single source, never the sum of them', () => {
    // Forty lairs at a day each are not common to anybody hunting one of them.
    const found = itemRarity(
      Array.from({ length: 40 }, (_, index) => drop(30, `orc ${index}`)),
      false,
      bounds
    );
    expect(found).toMatchObject({ rarity: 'rare', hours: 30 });
  });

  it('lists the quickest first and the unrated last', () => {
    const found = itemRarity([drop(null, 'a'), drop(200, 'b'), drop(3, 'c')], false, bounds);
    expect(found.sources.map((source) => source.hours)).toEqual([3, 200, null]);
    expect(found.rarity).toBe('uncommon');
  });

  it('never puts a limited item below rare', () => {
    expect(itemRarity([drop(0.1)], true, bounds)).toMatchObject({ rarity: 'rare', limited: true });
    expect(itemRarity([drop(800)], true, bounds).rarity).toBe('extremelyRare');
    expect(itemRarity([], true, bounds).rarity).toBe('rare');
  });

  it('calls a quest reward rare, with no hours', () => {
    expect(itemRarity([quest], false, bounds)).toMatchObject({ rarity: 'rare', hours: null });
  });

  it('calls an item with nothing rated unknown', () => {
    expect(itemRarity([], false, bounds).rarity).toBe('unknown');
    expect(itemRarity([drop(null)], false, bounds).rarity).toBe('unknown');
  });
});
