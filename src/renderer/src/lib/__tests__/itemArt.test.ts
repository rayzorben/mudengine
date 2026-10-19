import { describe, expect, it } from 'vitest';

import { asItemArtIndex, coinPicture, pictureOf, portraitOf } from '../itemArt';
import shipped from '../../assets/item-art-index.json';

const KEY = 'aaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbb';
const raw = {
  format: 1,
  byName: { 'golden pike': KEY },
  byId: { paradigm: { '191': OTHER }, greatermud: {} },
  coins: { platinum: KEY },
  portraits: ['dwarf-witchunter']
};

describe('item pictures', () => {
  it('reads the shipped index', () => {
    const index = asItemArtIndex(shipped);
    expect(index).not.toBeNull();
    expect(Object.keys(index!.byName).length).toBeGreaterThan(2000);
    expect(Object.keys(index!.coins).sort()).toEqual([
      'copper',
      'gold',
      'platinum',
      'runic',
      'silver'
    ]);
  });

  it('refuses an index of another format, and drops a value that is not a key', () => {
    expect(asItemArtIndex({ ...raw, format: 2 })).toBeNull();
    expect(asItemArtIndex({ ...raw, byName: { pike: 'not a key' } })?.byName).toEqual({});
  });

  it("finds a thing by the realm's row first, then by name", () => {
    const index = asItemArtIndex(raw)!;
    expect(pictureOf(index, 'paradigm', { name: 'golden pike', id: 191 })).toBe(
      `item-art/${OTHER}.webp`
    );
    expect(pictureOf(index, 'majormud', { name: 'Golden Pike ', id: 191 })).toBe(
      `item-art/${KEY}.webp`
    );
    expect(pictureOf(index, 'paradigm', { name: 'unknown thing' })).toBeNull();
  });

  it('draws a coin, and a portrait only where one was drawn', () => {
    const index = asItemArtIndex(raw)!;
    expect(coinPicture(index, 'platinum')).toBe(`item-art/${KEY}.webp`);
    expect(coinPicture(index, 'runic')).toBeNull();
    expect(portraitOf(index, 'Dwarf', 'Witchunter')).toBe(
      'item-art/portraits/dwarf-witchunter.webp'
    );
    expect(portraitOf(index, 'Elf', 'Mage')).toBeNull();
    expect(portraitOf(index, null, 'Mage')).toBeNull();
  });
});
