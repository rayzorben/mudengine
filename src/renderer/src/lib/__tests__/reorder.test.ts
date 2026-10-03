import { describe, expect, it } from 'vitest';

import { insertionIndex, reordered, wrappedInsertionIndex } from '../reorder';

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

/*
 * The rail's cards stand side by side in rows (todo 00), so the gap is found
 * in the row the pointer is in, and every card in an earlier row comes before
 * it. A one-card row is the old stacked rule.
 */
describe('which gap the pointer is in, when the lane wraps', () => {
  const box = (left: number, top: number, w = 100, h = 100) => ({
    left,
    right: left + w,
    top,
    bottom: top + h
  });
  /* Two cards side by side, then one below the first. */
  const rows = [box(0, 0), box(110, 0), box(0, 110)];

  it('is the plain gap along a strip', () => {
    const strip = [box(0, 0, 20), box(20, 0, 20), box(40, 0, 20)];
    for (const at of [0, 11, 31, 999]) {
      expect(wrappedInsertionIndex(strip, at, 5, false)).toBe(insertionIndex([10, 30, 50], at));
    }
  });

  it('is the stacked rule when every row holds one card', () => {
    const stack = [box(0, 0), box(0, 110), box(0, 220)];
    expect(wrappedInsertionIndex(stack, 50, 10, true)).toBe(0);
    expect(wrappedInsertionIndex(stack, 50, 90, true)).toBe(1);
    expect(wrappedInsertionIndex(stack, 50, 105, true)).toBe(1);
    expect(wrappedInsertionIndex(stack, 50, 300, true)).toBe(3);
  });

  it('counts every card in the rows above the pointer’s', () => {
    expect(wrappedInsertionIndex(rows, 50, 120, true)).toBe(2);
    expect(wrappedInsertionIndex(rows, 50, 190, true)).toBe(3);
  });

  it('finds the gap within the pointer’s own row', () => {
    expect(wrappedInsertionIndex(rows, 50, 10, true)).toBe(0);
    expect(wrappedInsertionIndex(rows, 50, 90, true)).toBe(1);
    expect(wrappedInsertionIndex(rows, 105, 10, true)).toBe(1);
    expect(wrappedInsertionIndex(rows, 150, 90, true)).toBe(2);
  });

  it('is the one gap of an empty lane', () => {
    expect(wrappedInsertionIndex([], 10, 10, true)).toBe(0);
  });
});
