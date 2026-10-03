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
 * The rail wraps into columns (todo 00): a column fills to the rail's height
 * and the next card starts the next one, so the gap is found in the column
 * the pointer is over and every card in an earlier column comes before it.
 */
describe('which gap the pointer is in, when the lane wraps', () => {
  /* Two columns from x 0 and x 300: cards at midpoints 50, 150 then 50. */
  const slots = [
    { line: 0, along: 50 },
    { line: 0, along: 150 },
    { line: 300, along: 50 }
  ];

  it('is the plain gap in one line', () => {
    const one = [10, 30, 50].map((along) => ({ line: 0, along }));
    for (const at of [0, 11, 31, 999]) {
      expect(wrappedInsertionIndex(one, at, 5)).toBe(insertionIndex([10, 30, 50], at));
    }
  });

  it('counts every box in the columns before the pointer’s', () => {
    expect(wrappedInsertionIndex(slots, 10, 320)).toBe(2);
    expect(wrappedInsertionIndex(slots, 90, 320)).toBe(3);
  });

  it('finds the gap within the pointer’s own column', () => {
    expect(wrappedInsertionIndex(slots, 10, 100)).toBe(0);
    expect(wrappedInsertionIndex(slots, 100, 100)).toBe(1);
    expect(wrappedInsertionIndex(slots, 200, 100)).toBe(2);
  });

  it('takes a pointer before the first column as in it', () => {
    expect(wrappedInsertionIndex(slots, 100, -40)).toBe(1);
  });

  it('is the one gap of an empty lane', () => {
    expect(wrappedInsertionIndex([], 10, 10)).toBe(0);
  });
});
