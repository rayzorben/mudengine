import { describe, expect, it } from 'vitest';

import { placesIn, WORN_SLOT } from '@shared/items';
import { crossings, DOLL_GEOMETRY, DOLL_SLOTS, layoutDoll, packColumn } from '../paperDoll';

describe('the paper doll', () => {
  it('has a square for every place of every worn slot', () => {
    const expected = Object.keys(WORN_SLOT).reduce((sum, code) => sum + placesIn(Number(code)), 0);
    expect(DOLL_SLOTS).toHaveLength(expected);
    expect(DOLL_SLOTS.filter((slot) => slot.word === 'Finger')).toHaveLength(2);
    expect(DOLL_SLOTS.filter((slot) => slot.word === 'Wrist')).toHaveLength(2);
  });

  it('lays every square out with no two lines crossing', () => {
    const placed = layoutDoll(DOLL_GEOMETRY);
    expect(placed).toHaveLength(DOLL_SLOTS.length);
    // The positive control: two lines that do cross are counted.
    expect(
      crossings([
        [
          [0, 0],
          [10, 10]
        ],
        [
          [0, 10],
          [10, 0]
        ]
      ])
    ).toBe(1);
    expect(crossings(placed.map((slot) => slot.line))).toBe(0);
  });

  it('keeps squares apart and inside the column', () => {
    const at = packColumn([10, 12, 14, 400], 48, 8, 0, 300);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(56);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(56);
    expect(at[3]! + 48).toBeLessThanOrEqual(300);
  });
});
