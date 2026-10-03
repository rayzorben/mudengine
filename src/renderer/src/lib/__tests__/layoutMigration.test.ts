import { describe, expect, it } from 'vitest';

import { withGridSizes } from '../layoutMigration';

/*
 * A rail 900px tall, 16px cells and a 12px gap: a card that took a fifth of
 * it was a 180px box, which is twelve cells with the gap under it.
 */
const rail = () => ({ rail: 900, cell: 16, gap: 12 });

describe('a layout stored before the rail was a grid', () => {
  it('turns each dragged height into whole cells and drops the old key', () => {
    const before = {
      rail: ['vitals', 'map'],
      heights: { vitals: 0.2, map: 0.19072284638633671 },
      rolled: []
    };
    expect(withGridSizes(before, rail)).toEqual({
      rail: ['vitals', 'map'],
      sizes: { vitals: { h: 12 }, map: { h: 11 } },
      rolled: []
    });
  });

  it('drops a height that is not a number', () => {
    expect(withGridSizes({ heights: { room: 'tall' } }, rail)).toEqual({ sizes: {} });
  });

  it('keeps the shipped sizes when the rail cannot be measured', () => {
    const unmeasured = () => ({ rail: 0, cell: 0, gap: 0 });
    expect(withGridSizes({ heights: { room: 0.5 } }, unmeasured)).toEqual({ sizes: {} });
  });

  it('hands back the same object for a layout already in the new shape', () => {
    const after = { rail: ['room'], sizes: { room: { w: 9, h: 9 } } };
    expect(withGridSizes(after, rail)).toBe(after);
  });
});
