import { describe, expect, it } from 'vitest';

import { RESIZE_EDGES } from '../resizeEdge';
import {
  arrange,
  bottomOf,
  fitted,
  highestFree,
  nearestFree,
  overlaps,
  resizedBy,
  resizedTo,
  scaled,
  squeezed,
  type GridBox
} from '../railGrid';

const box = (x: number, y: number, w: number, h: number): GridBox => ({ x, y, w, h });

/** No two boxes in an answer may share a cell: the rule the rail is built on. */
function apart(boxes: readonly GridBox[]): boolean {
  return boxes.every((a, i) => boxes.every((b, j) => i === j || !overlaps(a, b)));
}

describe('two boxes sharing a cell', () => {
  it('is an overlap', () => {
    expect(overlaps(box(0, 0, 4, 4), box(3, 3, 4, 4))).toBe(true);
  });

  it('is not, when they only touch along an edge', () => {
    expect(overlaps(box(0, 0, 4, 4), box(4, 0, 4, 4))).toBe(false);
    expect(overlaps(box(0, 0, 4, 4), box(0, 4, 4, 4))).toBe(false);
  });
});

describe('a box brought inside the grid', () => {
  it('moves left until its right edge is in the grid', () => {
    expect(fitted(box(30, 2, 17, 12), 40)).toEqual(box(23, 2, 17, 12));
  });

  it('is never wider than the grid', () => {
    expect(fitted(box(5, 0, 60, 12), 40)).toEqual(box(0, 0, 40, 12));
  });

  it('lands on whole cells, never above or left of the corner', () => {
    expect(fitted(box(-3.4, -2, 4.6, 2.2), 40)).toEqual(box(0, 0, 5, 2));
  });
});

/*
 * Festus's rail, 49 cells across: the map on the left 29 wide, Vitals on the
 * right 20 wide, the two meeting at cell 29.
 */
const map = box(0, 0, 29, 27);
const vitals = box(29, 0, 20, 14);
const on = (columns: number, stacked = false) => ({ columns, stacked });

describe('a box kept on a rail of another width', () => {
  it('is the same cells on the rail it was kept on', () => {
    expect(scaled(map, 49, on(49))).toEqual(map);
    expect(scaled(vitals, 49, on(49))).toEqual(vitals);
  });

  it('is narrower in proportion on a narrower rail, with its rows as they were', () => {
    expect(scaled(map, 49, on(38))).toEqual(box(0, 0, 22, 27));
    expect(scaled(vitals, 49, on(38))).toEqual(box(22, 0, 16, 14));
  });

  it('meets the box it met, whatever the width', () => {
    for (let columns = 17; columns <= 90; columns += 1) {
      const left = scaled(map, 49, on(columns));
      const right = scaled(vitals, 49, on(columns));
      expect(left.x + left.w).toBe(right.x);
      expect(right.x + right.w).toBe(columns);
    }
  });

  it('takes the whole width on a stacked rail', () => {
    expect(scaled(vitals, 49, on(17, true))).toEqual(box(0, 0, 17, 14));
  });

  it('is squeezed once its width in proportion rounds under the least', () => {
    // 20 of 49 is 10.61 cells of 26 and 10.20 of 25.
    expect(squeezed(vitals, 49, 26, 11)).toBe(false);
    expect(squeezed(vitals, 49, 25, 11)).toBe(true);
  });

  it('is never narrower on a wider rail than the one it was kept on', () => {
    for (let columns = 49; columns <= 90; columns += 1) {
      expect(scaled(vitals, 49, on(columns)).w).toBeGreaterThanOrEqual(20);
    }
  });
});

describe('the highest free cells in a column', () => {
  it('is the top row of an empty grid', () => {
    expect(highestFree(box(17, 40, 17, 12), [])).toEqual(box(17, 0, 17, 12));
  });

  it('is under the card in its columns, beside one that is not', () => {
    const taken = [box(0, 0, 17, 30), box(17, 0, 17, 12)];
    expect(highestFree(box(17, 50, 17, 12), taken)).toEqual(box(17, 12, 17, 12));
  });

  it('is a gap that holds it, above a card further down', () => {
    const taken = [box(0, 0, 17, 10), box(0, 24, 17, 10)];
    expect(highestFree(box(0, 0, 17, 14), taken)).toEqual(box(0, 10, 17, 14));
    expect(highestFree(box(0, 0, 17, 15), taken)).toEqual(box(0, 34, 17, 15));
  });
});

describe('arranging the rail', () => {
  it('draws a placed card where it was put', () => {
    const drawn = arrange(
      [{ id: 'map', size: { w: 17, h: 24 }, spot: { x: 10, y: 30 }, wanted: { x: 0, y: 0 } }],
      40
    );
    expect(drawn.get('map')).toEqual(box(10, 30, 17, 24));
  });

  it('raises each unplaced card in its own columns, the one wanted higher first', () => {
    const drawn = arrange(
      [
        { id: 'room', size: { w: 17, h: 12 }, wanted: { x: 20, y: 20 } },
        { id: 'map', size: { w: 20, h: 24 }, spot: { x: 0, y: 0 }, wanted: { x: 0, y: 0 } },
        { id: 'vitals', size: { w: 17, h: 12 }, wanted: { x: 20, y: 0 } }
      ],
      40
    );
    expect(drawn.get('map')).toEqual(box(0, 0, 20, 24));
    expect(drawn.get('vitals')).toEqual(box(20, 0, 17, 12));
    expect(drawn.get('room')).toEqual(box(20, 12, 17, 12));
  });

  it('leaves no gap where a card wanted above is not on the rail', () => {
    const drawn = arrange([{ id: 'combat', size: { w: 20, h: 13 }, wanted: { x: 29, y: 14 } }], 49);
    expect(drawn.get('combat')).toEqual(box(29, 0, 20, 13));
  });

  /*
   * A window made narrower than the one the cards were placed on: a card
   * past the right edge comes inside, and whatever it then lands on moves
   * down rather than being drawn over.
   */
  it('keeps every card apart on a grid narrower than the one they were placed on', () => {
    const drawn = arrange(
      [
        { id: 'a', size: { w: 17, h: 12 }, spot: { x: 0, y: 0 }, wanted: { x: 0, y: 0 } },
        { id: 'b', size: { w: 17, h: 12 }, spot: { x: 17, y: 0 }, wanted: { x: 0, y: 0 } },
        { id: 'c', size: { w: 17, h: 12 }, spot: { x: 34, y: 0 }, wanted: { x: 0, y: 0 } }
      ],
      20
    );
    expect(apart([...drawn.values()])).toBe(true);
    expect([...drawn.values()].every((b) => b.x + b.w <= 20)).toBe(true);
    expect(drawn.get('a')).toEqual(box(0, 0, 17, 12));
  });

  it('moves the later of two stored cards that share cells', () => {
    const drawn = arrange(
      [
        { id: 'a', size: { w: 10, h: 10 }, spot: { x: 0, y: 0 }, wanted: { x: 0, y: 0 } },
        { id: 'b', size: { w: 10, h: 10 }, spot: { x: 5, y: 5 }, wanted: { x: 0, y: 0 } }
      ],
      40
    );
    expect(drawn.get('a')).toEqual(box(0, 0, 10, 10));
    expect(drawn.get('b')).toEqual(box(5, 10, 10, 10));
  });

  it('answers the same arrangement for the same input', () => {
    const cards = [
      { id: 'a', size: { w: 9, h: 7 }, wanted: { x: 4, y: 3 } },
      { id: 'b', size: { w: 12, h: 5 }, spot: { x: 3, y: 2 }, wanted: { x: 0, y: 0 } },
      { id: 'c', size: { w: 6, h: 9 }, wanted: { x: 4, y: 3 } }
    ];
    expect([...arrange(cards, 30)]).toEqual([...arrange(cards, 30)]);
  });
});

describe('the free spot nearest the pointer', () => {
  it('is where the card is wanted, when nothing is there', () => {
    expect(nearestFree(box(20, 40, 17, 12), [box(0, 0, 17, 12)], 40)).toEqual(box(20, 40, 17, 12));
  });

  it('is the closest clear spot when the wanted one is taken', () => {
    const taken = [box(0, 0, 17, 12)];
    // Over its right half: beside it is five cells away, under it twelve.
    expect(nearestFree(box(12, 0, 17, 12), taken, 40)).toEqual(box(17, 0, 17, 12));
    // Over its left edge: under it is twelve away, beside it fourteen.
    expect(nearestFree(box(3, 0, 17, 12), taken, 40)).toEqual(box(3, 12, 17, 12));
  });

  it('can be below everything, which is always clear', () => {
    const taken = [box(0, 0, 20, 12), box(20, 0, 20, 12)];
    expect(nearestFree(box(5, 2, 17, 12), taken, 40)).toEqual(box(5, 12, 17, 12));
  });

  it('never overlaps what is there', () => {
    const taken = [box(0, 0, 17, 12), box(17, 0, 17, 14), box(0, 12, 10, 10)];
    for (let y = 0; y < 30; y += 3) {
      for (let x = 0; x < 30; x += 3) {
        expect(apart([...taken, nearestFree(box(x, y, 12, 9), taken, 40)])).toBe(true);
      }
    }
  });
});

describe('resizing a card to a size', () => {
  const least = { w: 6, h: 4 };

  it('grows into empty cells', () => {
    expect(resizedTo(box(0, 0, 17, 12), 'se', { w: 22, h: 20 }, [], 40, least)).toEqual(
      box(0, 0, 22, 20)
    );
  });

  it('stops at the card beside it and the card below it', () => {
    const taken = [box(20, 0, 10, 10), box(0, 16, 10, 10)];
    expect(resizedTo(box(0, 0, 17, 12), 'se', { w: 30, h: 30 }, taken, 40, least)).toEqual(
      box(0, 0, 20, 16)
    );
  });

  it('stops at the grid’s right edge and at the least size', () => {
    expect(resizedTo(box(30, 0, 8, 8), 'se', { w: 40, h: 1 }, [], 40, least)).toEqual(
      box(30, 0, 10, 4)
    );
  });
});

describe('dragging a card’s handle', () => {
  const least = { w: 6, h: 4 };
  const card = box(10, 10, 12, 8);

  it('moves only the sides the handle is on', () => {
    expect(resizedBy(card, 'e', { x: 3, y: 5 }, [], 40, least)).toEqual(box(10, 10, 15, 8));
    expect(resizedBy(card, 's', { x: 3, y: 5 }, [], 40, least)).toEqual(box(10, 10, 12, 13));
    expect(resizedBy(card, 'se', { x: 3, y: 5 }, [], 40, least)).toEqual(box(10, 10, 15, 13));
  });

  it('from the left or top, moves the spot and keeps the opposite side', () => {
    expect(resizedBy(card, 'w', { x: -4, y: 0 }, [], 40, least)).toEqual(box(6, 10, 16, 8));
    expect(resizedBy(card, 'n', { x: 0, y: -3 }, [], 40, least)).toEqual(box(10, 7, 12, 11));
    expect(resizedBy(card, 'nw', { x: 2, y: 2 }, [], 40, least)).toEqual(box(12, 12, 10, 6));
    expect(resizedBy(card, 'ne', { x: 2, y: -2 }, [], 40, least)).toEqual(box(10, 8, 14, 10));
    expect(resizedBy(card, 'sw', { x: -2, y: 2 }, [], 40, least)).toEqual(box(8, 10, 14, 10));
  });

  it('stops at the grid’s left and top edges', () => {
    expect(resizedBy(card, 'nw', { x: -30, y: -30 }, [], 40, least)).toEqual(box(0, 0, 22, 18));
  });

  it('stops at the card to the left and the card above', () => {
    const taken = [box(0, 10, 7, 8), box(10, 0, 12, 4)];
    expect(resizedBy(card, 'nw', { x: -9, y: -9 }, taken, 40, least)).toEqual(box(7, 4, 15, 14));
  });

  it('shrinks to the least size, keeping the side it was not taken by', () => {
    expect(resizedBy(card, 'nw', { x: 20, y: 20 }, [], 40, least)).toEqual(box(16, 14, 6, 4));
  });

  it('never overlaps a neighbour, from any handle and any travel', () => {
    const taken = [box(0, 0, 10, 10), box(22, 0, 10, 10), box(0, 18, 40, 6), box(22, 10, 5, 5)];
    for (const edge of RESIZE_EDGES) {
      for (let dy = -12; dy <= 12; dy += 3) {
        for (let dx = -12; dx <= 12; dx += 3) {
          const next = resizedBy(card, edge, { x: dx, y: dy }, taken, 40, least);
          expect(apart([...taken, next])).toBe(true);
          expect(next.x).toBeGreaterThanOrEqual(0);
          expect(next.y).toBeGreaterThanOrEqual(0);
          expect(next.x + next.w).toBeLessThanOrEqual(40);
        }
      }
    }
  });
});

describe('the bottom of the grid', () => {
  it('is the lowest edge of anything on it', () => {
    expect(bottomOf([box(0, 0, 5, 5), box(0, 9, 5, 3)])).toBe(12);
    expect(bottomOf([])).toBe(0);
  });
});
