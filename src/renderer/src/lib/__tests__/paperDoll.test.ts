import { describe, expect, it } from 'vitest';

import { placesIn, WORN_SLOT } from '@shared/items';
import {
  crossings,
  DOLL_BOX,
  DOLL_GEOMETRY,
  DOLL_SLOTS,
  DRAWING_GEOMETRY,
  layoutDoll,
  nameBoxOf,
  packColumn
} from '../paperDoll';

const overlaps = (
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number }
): boolean =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height;

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

  it('crosses no lines over the drawing either', () => {
    const placed = layoutDoll(DRAWING_GEOMETRY);
    expect(placed).toHaveLength(DOLL_SLOTS.length);
    expect(crossings(placed.map((slot) => slot.line))).toBe(0);
  });

  it('writes every name inside the box, clear of every other name and square', () => {
    for (const geometry of [DOLL_GEOMETRY, DRAWING_GEOMETRY]) {
      const placed = layoutDoll(geometry);
      const names = placed.map((slot) => nameBoxOf(slot, geometry));
      const squares = placed.map((slot) => ({
        left: slot.x,
        top: slot.y,
        width: geometry.size,
        height: geometry.size
      }));
      // The positive control: two boxes that do overlap are caught.
      expect(overlaps(names[0]!, { ...names[0]!, left: names[0]!.left + 1 })).toBe(true);
      for (const [i, name] of names.entries()) {
        expect(name.left).toBeGreaterThanOrEqual(0);
        expect(name.left + name.width).toBeLessThanOrEqual(DOLL_BOX.width);
        expect(name.top + name.height).toBeLessThanOrEqual(DOLL_BOX.height);
        for (const [j, other] of names.entries())
          if (i !== j) expect(overlaps(name, other)).toBe(false);
        for (const square of squares) expect(overlaps(name, square)).toBe(false);
      }
    }
  });

  it('keeps squares apart and inside the column', () => {
    const at = packColumn([10, 12, 14, 400], 48, 8, 0, 300);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(56);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(56);
    expect(at[3]! + 48).toBeLessThanOrEqual(300);
  });
});
