import { describe, expect, it } from 'vitest';

import { withGridSizes, withRailColumns } from '../layoutMigration';

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

describe('a layout stored before it kept the width of its rail', () => {
  /* Festus's rail as it was stored on 2026-10-05: two columns filling 49 cells. */
  const festus = {
    rail: ['vitals', 'map', 'conversation'],
    sizes: {
      vitals: { w: 20, h: 14 },
      map: { w: 29, h: 27 },
      conversation: { w: 49, h: 22 },
      inventory: { w: 20, h: 16 }
    },
    spots: { vitals: { x: 29, y: 0 }, map: { x: 0, y: 0 }, conversation: { x: 0, y: 49 } }
  };

  it('is kept on the rail the arrangement fills, its order the order it is read in', () => {
    expect(withRailColumns(festus)).toEqual({
      ...festus,
      rail: ['map', 'vitals', 'conversation'],
      columns: 49
    });
  });

  /* Main's rail: two cards placed with no size, beside a table that shipped 20 wide. */
  it('gives a placed card with no size the size it was drawn at then', () => {
    const main = {
      spots: { vitals: { x: 0, y: 0 }, room: { x: 17, y: 13 }, self: { x: 34, y: 0 } },
      sizes: { room: { w: 17, h: 12 } }
    };
    expect(withRailColumns(main)).toEqual({
      spots: main.spots,
      sizes: { room: { w: 17, h: 12 }, vitals: { w: 17, h: 13 }, self: { w: 20, h: 21 } },
      columns: 54
    });
  });

  it('hands back the same object for a layout with nothing to add', () => {
    const after = { spots: { room: { x: 0, y: 3 } }, sizes: {}, columns: 40 };
    expect(withRailColumns(after)).toBe(after);
    const fresh = { rail: ['room'] };
    expect(withRailColumns(fresh)).toBe(fresh);
  });
});
