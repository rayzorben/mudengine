import { describe, expect, it } from 'vitest';

import {
  densityFor,
  detailAt,
  dragged,
  extentOf,
  fittedTo,
  stillCovers,
  viewBoxFor,
  wheelFactor,
  windowForView,
  within,
  zoomedAt,
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

describe('the region’s extent', () => {
  it('is the region’s cells in map units', () => {
    expect(extentOf({ minX: -2, maxX: 3, minY: -4, maxY: 1 })).toEqual({
      minX: -20,
      maxX: 30,
      minY: -40,
      maxY: 10
    });
  });

  /* Todo 130: the pan reaches rooms main has not sent yet, as far as the region goes. */
  it('lets the pan reach a room past the fetched cells but inside the region', () => {
    const region = extentOf({ minX: -40, maxX: 40, minY: -5, maxY: 5 });
    const view = { perRoom: 20, pan: { x: 35 * MAP_CELL, y: 0 } };
    expect(within(view, region)).toBe(view);
    expect(within({ perRoom: 20, pan: { x: 60 * MAP_CELL, y: 0 } }, region).pan.x).toBe(
      40 * MAP_CELL
    );
  });
});

describe('what to fetch', () => {
  it('covers the window, with half a cell to spare', () => {
    // 400px at 20px a room is 20 rooms across, ten each side of the centre.
    expect(windowForView(centredView(20), box, 0, 2)).toEqual({
      minX: -11,
      maxX: 11,
      minY: -6,
      maxY: 6
    });
  });

  it('adds the margin as a share of the window each way', () => {
    expect(windowForView(centredView(20), box, 0.5, 2)).toEqual({
      minX: -21,
      maxX: 21,
      minY: -11,
      maxY: 11
    });
  });

  it('follows the pan', () => {
    expect(windowForView({ perRoom: 40, pan: { x: 30, y: 0 } }, box, 0, 2)).toEqual({
      minX: -3,
      maxX: 9,
      minY: -3,
      maxY: 3
    });
  });

  it('asks for a few rooms round the centre for a box not yet measured', () => {
    expect(windowForView(centredView(20), { width: 0, height: 0 }, 0.5, 2)).toEqual({
      minX: -2,
      maxX: 2,
      minY: -2,
      maxY: 2
    });
  });
});

describe('when to fetch again', () => {
  const fetched = { minX: -21, maxX: 21, minY: -11, maxY: 11 };
  const visibleAt = (x: number) => ({ minX: x - 11, maxX: x + 11, minY: -6, maxY: 6 });

  it('keeps the rectangle while the window’s middle is in its inner half', () => {
    expect(stillCovers(fetched, visibleAt(0), null)).toBe(true);
    expect(stillCovers(fetched, visibleAt(10), null)).toBe(true);
  });

  it('asks again once the window leaves the inner half or the rectangle', () => {
    expect(stillCovers(fetched, { minX: 1, maxX: 21, minY: -6, maxY: 6 }, null)).toBe(false);
    expect(stillCovers(fetched, visibleAt(11), null)).toBe(false);
  });

  it('never asks again once the rectangle holds the whole region', () => {
    const region = { minX: -5, maxX: 5, minY: -2, maxY: 2 };
    expect(stillCovers(fetched, visibleAt(30), region)).toBe(true);
  });
});

describe('how much a room shows', () => {
  it('is plain below the dense end and full at it', () => {
    expect(detailAt(9.9, 10)).toBe('plain');
    expect(detailAt(5, 10)).toBe('plain');
    expect(detailAt(10, 10)).toBe('full');
    expect(detailAt(40, 10)).toBe('full');
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

describe('fittedTo', () => {
  const cells = [
    { id: '1/1', gx: 0, gy: 0 },
    { id: '1/2', gx: 3, gy: 0 },
    { id: '1/3', gx: 3, gy: -1 },
    { id: '1/9', gx: -60, gy: 0 }
  ];
  const bounds = { min: 10, max: 40 };

  it('centres on the rooms asked for and zooms to hold them', () => {
    const view = fittedTo(cells, new Set(['1/1', '1/2', '1/3']), box, bounds);
    // Four cells across in 400px and two down in 200px: 100 each, clamped to 40.
    expect(view).toEqual({ perRoom: 40, pan: { x: 1.5 * MAP_CELL, y: -0.5 * MAP_CELL } });
  });

  it('stops at the widest zoom the map allows', () => {
    const view = fittedTo(cells, new Set(['1/9', '1/2']), box, bounds);
    expect(view?.perRoom).toBe(bounds.min);
  });

  it('keeping the end, drops rooms from the start that the widest zoom cannot hold', () => {
    // 1/9 to 1/2 is 64 cells across, 6.25px each in 400px, under the floor of 10.
    const view = fittedTo(cells, new Set(['1/9', '1/1', '1/2']), box, bounds, 'end');
    // 1/1 and 1/2 stay: four cells across, clamped to 40.
    expect(view).toEqual({ perRoom: 40, pan: { x: 1.5 * MAP_CELL, y: 0 } });
    // With the far room last, it is the one kept.
    const turned = fittedTo(cells, new Set(['1/2', '1/9']), box, bounds, 'end');
    expect(turned?.pan).toEqual({ x: -60 * MAP_CELL, y: 0 });
  });

  it('answers nothing when no room asked for is placed, or the box is unmeasured', () => {
    expect(fittedTo(cells, new Set(['2/2']), box, bounds)).toBeNull();
    expect(fittedTo(cells, new Set(['1/1']), { width: 0, height: 0 }, bounds)).toBeNull();
  });
});
