import { describe, expect, it } from 'vitest';

import { countByTime, timeBin } from '../timeBins';

describe('counting a record into slices of its own span', () => {
  it('puts the first moment in the first slice and the last in the last', () => {
    expect(timeBin(0, 0, 100, 4)).toBe(0);
    expect(timeBin(100, 0, 100, 4)).toBe(3);
    expect(timeBin(50, 0, 100, 4)).toBe(2);
  });

  it('puts a record of one moment in the last slice', () => {
    expect(timeBin(7, 7, 7, 5)).toBe(4);
    expect(countByTime([{ at: 7 }], (item) => item.at, 3)).toEqual([0, 0, 1]);
  });

  it('counts every item once, oldest first', () => {
    const items = [0, 10, 20, 90, 100].map((at) => ({ at }));
    expect(countByTime(items, (item) => item.at, 2)).toEqual([3, 2]);
    expect(countByTime([], (item: { at: number }) => item.at, 3)).toEqual([0, 0, 0]);
  });
});
