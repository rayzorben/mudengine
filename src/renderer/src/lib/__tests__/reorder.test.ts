import { describe, expect, it } from 'vitest';

import { insertionIndex, moved, reordered, rowUnderDrag } from '../reorder';

/*
 * The arithmetic both rails drag by. It lived in `useCardDrag` alone and was
 * about to be written a second time for the tab rail; two copies of it drift in
 * the way that is hardest to see, with the indicator pointing at one gap and
 * the drop landing in another.
 */
describe('which gap the pointer is in', () => {
  /* Three boxes 20 wide from 0: midpoints at 10, 30, 50. */
  const slots = [10, 30, 50];

  it('is nothing before the first midpoint', () => {
    expect(insertionIndex(slots, 0)).toBe(0);
    expect(insertionIndex(slots, 10)).toBe(0);
  });

  it('counts every midpoint already passed', () => {
    expect(insertionIndex(slots, 11)).toBe(1);
    expect(insertionIndex(slots, 31)).toBe(2);
  });

  it('is the end past the last midpoint', () => {
    expect(insertionIndex(slots, 999)).toBe(3);
  });

  /* No boxes is one gap, which is the empty rail a card can still be dropped
     into. Neither end needs a special case. */
  it('answers zero for an empty lane', () => {
    expect(insertionIndex([], 42)).toBe(0);
  });
});

describe('moving one entry to a gap', () => {
  const rail = ['vaelor', 'soul', 'probe'];

  it('moves a tab forwards, counting the gap it vacates', () => {
    // Gap 3 is the end of the list *as drawn*; with `vaelor` lifted out that is
    // the end of a two-item list.
    expect(reordered(rail, 'vaelor', 3)).toEqual(['soul', 'probe', 'vaelor']);
  });

  it('moves a tab backwards, where the gap needs no adjustment', () => {
    expect(reordered(rail, 'probe', 0)).toEqual(['probe', 'vaelor', 'soul']);
  });

  it('moves a tab one place', () => {
    expect(reordered(rail, 'vaelor', 2)).toEqual(['soul', 'vaelor', 'probe']);
  });

  /*
   * Both of an entry's own gaps are no move at all. Without this a drop back
   * where it started would still be a file written and a roster republished —
   * and the returned reference is how the caller can tell.
   */
  it('is the same list for either of the entry own gaps', () => {
    expect(reordered(rail, 'soul', 1)).toBe(rail);
    expect(reordered(rail, 'soul', 2)).toBe(rail);
  });

  it('is the same list for an entry that is not in it', () => {
    expect(reordered(rail, 'nobody', 0)).toBe(rail);
  });

  it('leaves a single-entry list alone whichever gap it is dropped in', () => {
    const one = ['vaelor'];
    expect(reordered(one, 'vaelor', 0)).toBe(one);
    expect(reordered(one, 'vaelor', 1)).toBe(one);
  });
});

describe('a row moved from one place to another', () => {
  const rows = ['health', 'mana', 'attacked'];

  it('moves a row down and up', () => {
    expect(moved(rows, 0, 2)).toEqual(['mana', 'attacked', 'health']);
    expect(moved(rows, 2, 0)).toEqual(['attacked', 'health', 'mana']);
  });

  it('is the same list when nothing moves or a place is outside it', () => {
    expect(moved(rows, 1, 1)).toBe(rows);
    expect(moved(rows, 0, -1)).toBe(rows);
    expect(moved(rows, 2, 3)).toBe(rows);
  });
});

describe('the place a dragged row takes', () => {
  /* A short row, a tall one with a warning under it, a short one. */
  const rows = [
    { start: 0, end: 30 },
    { start: 30, end: 90 },
    { start: 90, end: 120 }
  ];

  it('stays put until the pointer passes a neighbour midpoint', () => {
    expect(rowUnderDrag(rows, 0, 59)).toBe(0);
    expect(rowUnderDrag(rows, 0, 61)).toBe(1);
    expect(rowUnderDrag(rows, 2, 61)).toBe(2);
    expect(rowUnderDrag(rows, 2, 59)).toBe(1);
  });

  it('goes past several rows at once', () => {
    expect(rowUnderDrag(rows, 0, 110)).toBe(2);
    expect(rowUnderDrag(rows, 2, 5)).toBe(0);
  });

  /* The short row went under the tall one at 61; the tall one now starts at 0. */
  it('holds still after the two rows swap', () => {
    const swapped = [
      { start: 0, end: 60 },
      { start: 60, end: 90 },
      { start: 90, end: 120 }
    ];
    expect(rowUnderDrag(swapped, 1, 61)).toBe(1);
  });
});
