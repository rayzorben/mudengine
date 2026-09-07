import { describe, expect, it } from 'vitest';

import {
  densityFor,
  dragged,
  extentOf,
  radiusForView,
  viewBoxFor,
  wheelFactor,
  within,
  zoomedAt,
  zoomFloor,
  type MapView
} from '../mapView';
import { MAP_CELL } from '@shared/map';

const box = { width: 400, height: 200 };
const centre = { x: 50, y: 30 };
const centredView = (perRoom: number): MapView => ({ perRoom, pan: { x: 0, y: 0 } });

describe('the window', () => {
  it('has the box’s aspect and is centred on the centre room', () => {
    const view = centredView(20);
    const window = viewBoxFor(view, box, centre);
    // Twenty pixels a room, rooms ten units apart: half a unit per pixel.
    expect(window.width).toBe(200);
    expect(window.height).toBe(100);
    expect(window.x + window.width / 2).toBe(centre.x);
    expect(window.y + window.height / 2).toBe(centre.y);
  });

  it('is moved by the pan, in map units', () => {
    const window = viewBoxFor({ perRoom: 20, pan: { x: 15, y: -5 } }, box, centre);
    expect(window.x + window.width / 2).toBe(centre.x + 15);
    expect(window.y + window.height / 2).toBe(centre.y - 5);
  });
});

describe('the wheel', () => {
  it('zooms in rolled away from the reader and out rolled towards, one step a notch', () => {
    // Away is a negative delta, as every scrolling surface reports it.
    expect(wheelFactor(-100, 25)).toBeCloseTo(1.25);
    expect(wheelFactor(100, 25)).toBeCloseTo(1 / 1.25);
  });

  it('takes a trackpad’s smaller deltas as a fraction of a step', () => {
    expect(wheelFactor(-50, 25)).toBeCloseTo(Math.sqrt(1.25));
  });

  it('never takes more than one step on one event', () => {
    expect(wheelFactor(-1000, 25)).toBeCloseTo(1.25);
    expect(wheelFactor(1000, 25)).toBeCloseTo(1 / 1.25);
  });

  it('does nothing for no movement', () => {
    expect(wheelFactor(0, 25)).toBe(1);
    expect(wheelFactor(Number.NaN, 25)).toBe(1);
  });
});

describe('zooming about a point', () => {
  const bounds = { min: 10, max: 40 };

  /* The whole point: the map under the pointer does not move. */
  it('keeps the map point under the pointer where it is', () => {
    const view = { perRoom: 20, pan: { x: 4, y: -6 } };
    const at = { x: 300, y: 50 };
    const before = viewBoxFor(view, box, centre);
    const underBefore = {
      x: before.x + (at.x / box.width) * before.width,
      y: before.y + (at.y / box.height) * before.height
    };
    const next = zoomedAt(view, box, at, 1.5, bounds);
    const after = viewBoxFor(next, box, centre);
    const underAfter = {
      x: after.x + (at.x / box.width) * after.width,
      y: after.y + (at.y / box.height) * after.height
    };
    expect(next.perRoom).toBe(30);
    expect(underAfter.x).toBeCloseTo(underBefore.x);
    expect(underAfter.y).toBeCloseTo(underBefore.y);
  });

  it('zooms about the centre without moving the pan', () => {
    const view = { perRoom: 20, pan: { x: 4, y: -6 } };
    const next = zoomedAt(view, box, { x: 200, y: 100 }, 2, bounds);
    expect(next.pan).toEqual({ x: 4, y: -6 });
  });

  it('clamps to the bounds, and returns the same view at a bound', () => {
    const view = centredView(40);
    expect(zoomedAt(view, box, { x: 0, y: 0 }, 2, bounds)).toBe(view);
    const floor = zoomedAt(centredView(12), box, { x: 0, y: 0 }, 0.5, bounds);
    expect(floor.perRoom).toBe(10);
  });
});

describe('dragging', () => {
  it('moves the eye the other way from the hand, in map units', () => {
    const start = { perRoom: 20, pan: { x: 0, y: 0 } };
    // Twenty pixels right is one room; the eye moves one room west.
    expect(dragged(start, 20, -40).pan).toEqual({ x: -MAP_CELL, y: 2 * MAP_CELL });
  });

  it('is stated from the start, so a hand that comes back leaves no drift', () => {
    const start = { perRoom: 20, pan: { x: 5, y: 5 } };
    expect(dragged(start, 0, 0).pan).toEqual(start.pan);
    expect(dragged(start, 30, 0).pan.x - start.pan.x).toBe(
      3 * (dragged(start, 10, 0).pan.x - start.pan.x)
    );
  });
});

describe('staying inside the drawing', () => {
  const extent = { minX: -30, maxX: 50, minY: -20, maxY: 20 };

  it('leaves a pan inside the extent alone, by reference', () => {
    const view = { perRoom: 20, pan: { x: 10, y: -10 } };
    expect(within(view, extent)).toBe(view);
  });

  it('brings a pan past the edge back to it', () => {
    expect(within({ perRoom: 20, pan: { x: 80, y: -50 } }, extent).pan).toEqual({ x: 50, y: -20 });
  });
});

describe('the drawing’s extent', () => {
  it('is measured from the centre room, in map units', () => {
    expect(
      extentOf([
        { gx: 0, gy: 0 },
        { gx: -2, gy: 1 },
        { gx: 3, gy: -4 }
      ])
    ).toEqual({ minX: -20, maxX: 30, minY: -40, maxY: 10 });
  });

  it('is nothing for no rooms', () => {
    expect(extentOf([])).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
  });
});

describe('how far to fetch', () => {
  it('covers the window, with half a cell to spare', () => {
    // 400px at 20px a room is 20 rooms across, ten each side of the centre.
    expect(radiusForView(centredView(20), box, 2, 12)).toBe(11);
  });

  it('reaches further as the eye is panned away', () => {
    expect(radiusForView({ perRoom: 40, pan: { x: 30, y: 0 } }, box, 2, 12)).toBe(9);
    expect(radiusForView(centredView(40), box, 2, 12)).toBe(6);
  });

  it('is the floor for a box not yet measured', () => {
    expect(radiusForView(centredView(20), { width: 0, height: 0 }, 2, 12)).toBe(2);
  });

  it('is clamped to the bounds', () => {
    expect(radiusForView(centredView(10), { width: 2000, height: 2000 }, 2, 12)).toBe(12);
    expect(radiusForView(centredView(40), { width: 40, height: 40 }, 2, 12)).toBe(2);
  });
});

describe('the smallest a room may be drawn', () => {
  it('is the slider’s dense end on a rail-sized box', () => {
    // 254px across, twenty-five rooms fetched at most: ten pixels each.
    expect(zoomFloor({ width: 254, height: 200 }, 10, 12)).toBeCloseTo(10.16);
    expect(zoomFloor({ width: 200, height: 200 }, 10, 12)).toBe(10);
  });

  it('rises with the box, so the widest fetch always spans the longer side', () => {
    expect(zoomFloor({ width: 640, height: 400 }, 10, 12)).toBeCloseTo(25.6);
    expect(zoomFloor({ width: 400, height: 640 }, 10, 12)).toBeCloseTo(25.6);
  });

  it('is the dense end for a box not yet measured', () => {
    expect(zoomFloor({ width: 0, height: 0 }, 10, 12)).toBe(10);
  });
});

describe('the density the zoom means', () => {
  it('is the inverse of the slider’s two ends', () => {
    expect(densityFor(40, 40, 10)).toBe(0);
    expect(densityFor(10, 40, 10)).toBe(1);
    expect(densityFor(25, 40, 10)).toBe(0.5);
  });

  it('is clamped and rounded to a hundredth', () => {
    expect(densityFor(50, 40, 10)).toBe(0);
    expect(densityFor(5, 40, 10)).toBe(1);
    expect(densityFor(23.3, 40, 10)).toBe(0.56);
  });
});
