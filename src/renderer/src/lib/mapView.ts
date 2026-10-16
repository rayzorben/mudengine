/**
 * Where a map is looked at from: how large a room is drawn, and how far the
 * eye has been moved off the room the neighbourhood was fetched around.
 *
 * The picture used to be *fitted* — whatever neighbourhood arrived was scaled
 * into the box — so zooming meant fetching more rooms and there was nothing
 * to pan. Both the Map card and the loop builder now look through a window
 * instead: the zoom says how many pixels a room gets, the pan says where the
 * window's centre is, and what to fetch is whatever the window can see. One
 * module for both, because two maps that pan differently are two maps.
 *
 * Everything here is arithmetic on a view, a box and a point, and is here
 * rather than in the component for the reason `layoutMap` gives: these are
 * the edge cases — the point under the pointer staying put across a zoom, a
 * pan that never leaves the drawing — and the suite runs with no DOM.
 *
 * Units: `perRoom` is pixels per room cell; `pan` is in **map units** (rooms
 * are `MAP_CELL` apart), measured from the centre room, so the view is stable
 * whichever way the fetched extent grows — `layoutMap` puts its origin at the
 * extent's corner, and a pan stated from there would jump every time a fetch
 * placed a room further west.
 */
import { MAP_CELL, type MapWindow } from '@shared/map';

export interface MapView {
  /** Pixels one room cell gets: the zoom. */
  perRoom: number;
  /** The window's centre, in map units from the centre room. */
  pan: { x: number; y: number };
}

/** A laid-out box, in pixels. */
export interface Box {
  width: number;
  height: number;
}

/** A point, in pixels from the box's top-left corner. */
export interface Point {
  x: number;
  y: number;
}

/** A viewBox: what the SVG shows, in map units. */
export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How far the flat region extends from the centre room, in map units: the
 * pan is kept inside this.
 */
export interface Extent {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export const NO_PAN = { x: 0, y: 0 } as const;

/** Map units per pixel at this zoom. */
function unitsPerPixel(perRoom: number): number {
  return MAP_CELL / perRoom;
}

/**
 * Whether a box has been laid out at all. The first paint and a collapsed
 * pane both measure zero, and a window of no size has nothing to say.
 */
function measured(box: Box): boolean {
  return (
    Number.isFinite(box.width) && Number.isFinite(box.height) && box.width > 0 && box.height > 0
  );
}

/**
 * How a map draws its rooms at this zoom (todo 130): `full` with every mark,
 * or `plain` below the density slider's dense end, where a room is its plain
 * shape and only the `you` ring and the route line are drawn over it.
 */
export type MapDetail = 'full' | 'plain';

export function detailAt(perRoom: number, dense: number): MapDetail {
  return perRoom < dense ? 'plain' : 'full';
}

/**
 * The viewBox for a box of this size, looking from `view` around the centre
 * room, whose position in the drawing is `centre`.
 *
 * The window's aspect is the box's exactly, so `xMidYMid meet` scales it
 * one-to-one and a pixel measured on the box is a known number of map units —
 * which is what lets the wheel keep the room under the pointer where it is.
 */
export function viewBoxFor(view: MapView, box: Box, centre: Point): ViewBox {
  const upp = unitsPerPixel(view.perRoom);
  const width = box.width * upp;
  const height = box.height * upp;
  return {
    x: centre.x + view.pan.x - width / 2,
    y: centre.y + view.pan.y - height / 2,
    width,
    height
  };
}

/**
 * The zoom factor one wheel event asks for.
 *
 * Rolled away from the reader is *in* — closer, larger rooms — and towards
 * is *out*, which is the direction every map on every desktop reads a wheel:
 * away is a negative `deltaY`, so the notch count below is its negation. One
 * notch of a mouse wheel is a hundred units and takes a whole step;
 * a trackpad reports a stream of smaller deltas and takes the same step over
 * the same distance, so the two feel alike. Bounded to one step per event,
 * because an inertial fling reports deltas of several hundred and a map that
 * leapt four steps on one of them is a map nobody can aim.
 */
export function wheelFactor(deltaY: number, stepPercent: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  const step = 1 + Math.max(0, stepPercent) / 100;
  const notches = Math.max(-1, Math.min(1, -deltaY / 100));
  return Math.pow(step, notches);
}

/**
 * The view after zooming by `factor` about the point `at` — the room under
 * the pointer stays under the pointer.
 *
 * The point's offset from the box's centre is a fixed number of pixels and a
 * different number of map units before and after; the pan absorbs the
 * difference. The same view back, by reference, when the zoom is already at
 * the bound it was pushed against, so a caller can tell a wheel that did
 * nothing from one that did.
 */
export function zoomedAt(
  view: MapView,
  box: Box,
  at: Point,
  factor: number,
  bounds: { min: number; max: number }
): MapView {
  const next = Math.max(bounds.min, Math.min(bounds.max, view.perRoom * factor));
  if (!Number.isFinite(next) || next === view.perRoom) return view;
  const before = unitsPerPixel(view.perRoom);
  const after = unitsPerPixel(next);
  const dx = at.x - box.width / 2;
  const dy = at.y - box.height / 2;
  return {
    perRoom: next,
    pan: { x: view.pan.x + dx * (before - after), y: view.pan.y + dy * (before - after) }
  };
}

/**
 * The view after the picture was dragged by `(dx, dy)` pixels from where the
 * drag began. The picture follows the hand, so the eye moves the other way;
 * stated from the drag's *start* rather than accumulated, so a long drag
 * cannot drift by rounding.
 */
export function dragged(start: MapView, dx: number, dy: number): MapView {
  const upp = unitsPerPixel(start.perRoom);
  return { perRoom: start.perRoom, pan: { x: start.pan.x - dx * upp, y: start.pan.y - dy * upp } };
}

/**
 * The view with its pan kept inside the flat region (`LocalMap.extent`), so
 * the window's centre can be taken to the furthest room the map places, and
 * no further into the dark, whether or not those rooms have arrived yet.
 */
export function within(view: MapView, extent: Extent): MapView {
  const x = Math.max(extent.minX, Math.min(extent.maxX, view.pan.x));
  const y = Math.max(extent.minY, Math.min(extent.maxY, view.pan.y));
  if (x === view.pan.x && y === view.pan.y) return view;
  return { perRoom: view.perRoom, pan: { x, y } };
}

/**
 * The cells to ask main for: the window's rectangle round the centre room at
 * this zoom and pan, plus `margin` of the window's size each way, plus the
 * half cell a room centred just outside the edge still pokes in (todo 130).
 * A box not yet measured asks for `unmeasured` cells each way, since a map
 * that fetched nothing would flash empty on every mount.
 */
export function windowForView(
  view: MapView,
  box: Box,
  margin: number,
  unmeasured: number
): MapWindow {
  if (!measured(box) || !Number.isFinite(view.perRoom) || view.perRoom <= 0) {
    const reach = Number.isFinite(unmeasured) ? Math.max(0, Math.round(unmeasured)) : 0;
    return { minX: -reach, maxX: reach, minY: -reach, maxY: reach };
  }
  const upp = unitsPerPixel(view.perRoom);
  // A margin that is not a number would make every edge one, and the view ask on every render.
  const grow = 1 + 2 * (Number.isFinite(margin) ? Math.max(0, margin) : 0);
  const reachX = ((box.width * upp) / 2 / MAP_CELL) * grow + 0.5;
  const reachY = ((box.height * upp) / 2 / MAP_CELL) * grow + 0.5;
  const x = view.pan.x / MAP_CELL;
  const y = view.pan.y / MAP_CELL;
  return {
    minX: Math.floor(x - reachX),
    maxX: Math.ceil(x + reachX),
    minY: Math.floor(y - reachY),
    maxY: Math.ceil(y + reachY)
  };
}

/**
 * Whether the rectangle already fetched still serves the window: it holds
 * the whole region, or it holds the window and the window's middle is still
 * in its inner half. A pan inside that half asks for nothing.
 */
export function stillCovers(
  fetched: MapWindow,
  visible: MapWindow,
  region: MapWindow | null
): boolean {
  const holds = (outer: MapWindow, inner: MapWindow): boolean =>
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY;
  if (region !== null && holds(fetched, region)) return true;
  if (!holds(fetched, visible)) return false;
  const quarterX = (fetched.maxX - fetched.minX) / 4;
  const quarterY = (fetched.maxY - fetched.minY) / 4;
  const x = (visible.minX + visible.maxX) / 2;
  const y = (visible.minY + visible.maxY) / 2;
  return (
    x >= fetched.minX + quarterX &&
    x <= fetched.maxX - quarterX &&
    y >= fetched.minY + quarterY &&
    y <= fetched.maxY - quarterY
  );
}

/** A region in cells (`LocalMap.extent`) in the map units the pan is stated in. */
export function extentOf(region: MapWindow): Extent {
  return {
    minX: region.minX * MAP_CELL,
    maxX: region.maxX * MAP_CELL,
    minY: region.minY * MAP_CELL,
    maxY: region.maxY * MAP_CELL
  };
}

/**
 * The zoom as the Map card's density setting states it — a fraction from the
 * sparse end to the dense one — so a wheel on the card and the slider in its
 * settings are one number read two ways. Inverse of `roomPixelsFor`.
 */
export function densityFor(perRoom: number, sparse: number, dense: number): number {
  if (dense === sparse) return 0;
  const at = (perRoom - sparse) / (dense - sparse);
  return Math.max(0, Math.min(1, Math.round(at * 100) / 100));
}

/**
 * The view that shows every placed room of `rooms` at once: the pan on the
 * middle of their box and the largest zoom that holds it, with half a cell
 * round the edge so a room at the rim is drawn whole. Clamped to `bounds`,
 * so a leg wider than the box at the floor is shown as far out as the map goes.
 * Null when the box is not measured or none of the rooms is placed.
 */
export function fittedTo(
  cells: ReadonlyArray<{ id: string; gx: number; gy: number }>,
  rooms: ReadonlySet<string>,
  box: Box,
  bounds: { min: number; max: number }
): MapView | null {
  if (!measured(box)) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const cell of cells) {
    if (!rooms.has(cell.id)) continue;
    minX = Math.min(minX, cell.gx);
    maxX = Math.max(maxX, cell.gx);
    minY = Math.min(minY, cell.gy);
    maxY = Math.max(maxY, cell.gy);
  }
  if (minX === Infinity) return null;
  const across = Math.min(box.width / (maxX - minX + 1), box.height / (maxY - minY + 1));
  return {
    perRoom: Math.max(bounds.min, Math.min(bounds.max, across)),
    pan: { x: ((minX + maxX) / 2) * MAP_CELL, y: ((minY + maxY) / 2) * MAP_CELL }
  };
}
