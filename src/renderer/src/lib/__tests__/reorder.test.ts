import { describe, expect, it } from 'vitest';

import { insertionIndex, reordered } from '../reorder';

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
