import { describe, expect, it } from 'vitest';

import { RESIZE_EDGES, sidesOf, stretched } from '../resizeEdge';

const least = { w: 0.12, h: 0.1 };
const box = { x: 0.4, y: 0.4, w: 0.3, h: 0.3 };

describe('the eight handles', () => {
  it('are four corners and four sides, each moving its own sides', () => {
    expect(RESIZE_EDGES).toHaveLength(8);
    for (const edge of RESIZE_EDGES) {
      const { x, y } = sidesOf(edge);
      expect(x === 0 ? !/[ew]/.test(edge) : edge.includes(x === 1 ? 'e' : 'w')).toBe(true);
      expect(y === 0 ? !/[ns]/.test(edge) : edge.includes(y === 1 ? 's' : 'n')).toBe(true);
    }
  });
});

describe('stretching a float', () => {
  it('from the right and bottom, keeps the corner', () => {
    const next = stretched(box, 'se', { x: 0.1, y: -0.05 }, least);
    expect(next.x).toBe(0.4);
    expect(next.y).toBe(0.4);
    expect(next.w).toBeCloseTo(0.4);
    expect(next.h).toBeCloseTo(0.25);
  });

  it('from the left and top, moves the corner and keeps the far sides', () => {
    const next = stretched(box, 'nw', { x: -0.1, y: 0.05 }, least);
    expect(next.x).toBeCloseTo(0.3);
    expect(next.y).toBeCloseTo(0.45);
    expect(next.x + next.w).toBeCloseTo(0.7);
    expect(next.y + next.h).toBeCloseTo(0.7);
  });

  it('a side moves one axis only', () => {
    expect(stretched(box, 'n', { x: 0.2, y: -0.1 }, least).w).toBe(0.3);
    expect(stretched(box, 'e', { x: 0.1, y: 0.2 }, least).h).toBe(0.3);
  });

  it('stops at the least size and the workspace’s edges', () => {
    const small = stretched(box, 'nw', { x: 0.5, y: 0.5 }, least);
    expect(small.w).toBeCloseTo(least.w);
    expect(small.x + small.w).toBeCloseTo(0.7);
    const big = stretched(box, 'nw', { x: -1, y: -1 }, least);
    expect(big).toEqual({ x: 0, y: 0, w: 0.7, h: 0.7 });
    expect(stretched(box, 'e', { x: 1, y: 0 }, least).w).toBeCloseTo(0.6);
  });
});
