import { describe, expect, it } from 'vitest';

import {
  autoLayout,
  laidWidth,
  rowsFor,
  sizeOfCells,
  type FitCard,
  type FitFrame
} from '../autoLayout';
import type { CardSize } from '../cardSize';
import { overlaps, type GridBox } from '../railGrid';

/*
 * The rail as it ships: 16px cells, a 12px gap, a card medium from 160px and
 * large from 300px. A card's box is its cells less the gap, so medium starts
 * at 11 rows, and a card 17 wide (260px) is never large; 20 wide (308px) is
 * large from 20 rows.
 */
const FRAME: FitFrame = {
  columns: 17,
  rows: 40,
  cell: 16,
  gap: 12,
  bounds: { medium: 160, large: 300 },
  least: { w: 6, h: 4 }
};

const card = (
  id: string,
  rows: number,
  needs: Partial<Record<CardSize, number>>,
  columns = 17
): FitCard<string> => ({ id, shipped: { w: columns, h: rows }, needs });

const heights = (boxes: Map<string, GridBox>): Record<string, number> =>
  Object.fromEntries([...boxes].map(([id, box]) => [id, box.h]));

function apart(boxes: Map<string, GridBox>): boolean {
  const all = [...boxes.values()];
  return all.every((a, i) => all.every((b, j) => i === j || !overlaps(a, b)));
}

describe('the cells a card needs', () => {
  it('counts the gap a box leaves under it', () => {
    expect(rowsFor(160, FRAME)).toBe(11);
    expect(rowsFor(148, FRAME)).toBe(10);
  });

  it('reads the size a box draws off its cells', () => {
    expect(sizeOfCells({ w: 17, h: 10 }, FRAME)).toBe('small');
    expect(sizeOfCells({ w: 17, h: 11 }, FRAME)).toBe('medium');
    expect(sizeOfCells({ w: 17, h: 40 }, FRAME)).toBe('medium');
    expect(sizeOfCells({ w: 20, h: 20 }, FRAME)).toBe('large');
  });

  it('lays a card out at its shipped width, as far as the grid has room', () => {
    expect(laidWidth({ w: 20, h: 13 }, 40)).toBe(20);
    expect(laidWidth({ w: 20, h: 13 }, 17)).toBe(17);
  });
});

describe('auto layout', () => {
  it('gives each card the rows its content takes, never fewer than its size needs', () => {
    const plan = autoLayout(
      [card('vitals', 13, { medium: 8 }), card('room', 14, { medium: 12 })],
      FRAME
    );
    expect(heights(plan.boxes)).toEqual({ vitals: 11, room: 12 });
    expect(plan.boxes.get('room')).toEqual({ x: 0, y: 11, w: 17, h: 12 });
    expect(plan.unmeasured).toEqual([]);
  });

  it('grows a card whose content runs past its shipped height into the rows left in view', () => {
    const plan = autoLayout(
      [
        card('vitals', 13, { medium: 8 }),
        card('room', 14, { medium: 12 }),
        card('talk', 15, { medium: 90 })
      ],
      FRAME
    );
    expect(heights(plan.boxes)).toEqual({ vitals: 11, room: 12, talk: 17 });
  });

  it('steps the lowest cards down a size before leaving any to scroll', () => {
    const plan = autoLayout(
      [
        card('vitals', 13, { medium: 13, small: 5 }),
        card('combat', 13, { medium: 13, small: 5 }),
        card('room', 13, { medium: 13, small: 5 })
      ],
      { ...FRAME, rows: 30 }
    );
    expect(heights(plan.boxes)).toEqual({ vitals: 13, combat: 5, room: 5 });
    expect(plan.sizes.get('vitals')).toBe('medium');
    expect(plan.sizes.get('room')).toBe('small');
  });

  it('names a card stepped to a size it was not measured at, tried at the most that size allows', () => {
    const plan = autoLayout(
      [
        card('vitals', 13, { medium: 13 }),
        card('room', 13, { medium: 13 }),
        card('map', 13, { medium: 13 })
      ],
      { ...FRAME, rows: 30 }
    );
    expect(heights(plan.boxes)).toEqual({ vitals: 10, room: 10, map: 10 });
    expect(plan.unmeasured).toEqual(['vitals', 'room', 'map']);
  });

  it('leaves the rest to scroll when no card can step down any further', () => {
    const plan = autoLayout(
      [card('vitals', 13, { medium: 13, small: 9 }), card('room', 13, { medium: 13, small: 9 })],
      { ...FRAME, rows: 12 }
    );
    expect(heights(plan.boxes)).toEqual({ vitals: 9, room: 9 });
    expect(apart(plan.boxes)).toBe(true);
  });

  it('keeps a large card large while it fits', () => {
    const plan = autoLayout([card('self', 21, { large: 25 }, 20)], { ...FRAME, columns: 20 });
    expect(plan.boxes.get('self')).toEqual({ x: 0, y: 0, w: 20, h: 25 });
    expect(plan.sizes.get('self')).toBe('large');
  });

  it('stands cards side by side where the rail is wide enough, in the order given', () => {
    const plan = autoLayout(
      [
        card('vitals', 13, { medium: 13 }),
        card('room', 13, { medium: 13 }),
        card('map', 13, { medium: 13 })
      ],
      { ...FRAME, columns: 34 }
    );
    expect(plan.boxes.get('vitals')).toEqual({ x: 0, y: 0, w: 17, h: 13 });
    expect(plan.boxes.get('room')).toEqual({ x: 17, y: 0, w: 17, h: 13 });
    expect(plan.boxes.get('map')).toEqual({ x: 0, y: 13, w: 17, h: 13 });
  });

  it('keeps a rolled card the cells it has', () => {
    const rolled = { ...card('party', 14, {}), keep: { w: 12, h: 9 } };
    const plan = autoLayout([rolled, card('room', 13, { medium: 13 })], FRAME);
    expect(plan.boxes.get('party')).toEqual({ x: 0, y: 0, w: 12, h: 9 });
    expect(plan.sizes.get('party')).toBeNull();
    expect(plan.unmeasured).toEqual([]);
    expect(apart(plan.boxes)).toBe(true);
  });
});
