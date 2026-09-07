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
import { MAP_CELL } from '@shared/map';

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
 * How far the drawing extends from the centre room, in map units — the pan
 * is kept inside this, so the eye can be taken to the edge of what was
 * fetched and no further into the dark.
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
 * The smallest a room may be drawn in a box of this size: the zoom at which
 * the widest neighbourhood main will fetch (`mapRadiusMax` each way) exactly
 * spans the box's longer side.
 *
 * Below it the window asks for more rooms than can be fetched and shows
 * blank space around what was — which the fitted picture never could, because
 * it scaled whatever arrived to fill the box, and which a window at the
 * density slider's dense end would in any float larger than a rail card: ten
 * pixels a room across six hundred is sixty rooms, and the fetch stops at
 * twenty-five. So *densest* is this or the slider's end, whichever is the
 * larger room; on a rail card they are the same number. The floor for a box
 * not yet measured, so nothing decides on a size that is not there.
 */
export function zoomFloor(box: Box, dense: number, radiusMax: number): number {
  if (!measured(box)) return dense;
  const cells = 2 * Math.max(0, radiusMax) + 1;
  return Math.max(dense, Math.max(box.width, box.height) / cells);
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
 * The view with its pan kept inside the drawing, so the window's centre never
 * leaves the rooms that were fetched. It can be taken *to* the edge — which
 * is what asks the next fetch for more — and no further.
 */
export function within(view: MapView, extent: Extent): MapView {
  const x = Math.max(extent.minX, Math.min(extent.maxX, view.pan.x));
  const y = Math.max(extent.minY, Math.min(extent.maxY, view.pan.y));
  if (x === view.pan.x && y === view.pan.y) return view;
  return { perRoom: view.perRoom, pan: { x, y } };
}

/**
 * How far out to fetch so the window is covered: the furthest point the
 * window reaches from the centre room, in cells, plus the half cell a room
 * centred just outside the edge still pokes into it. Clamped to the same
 * bounds main clamps to, and the floor for a box not yet measured — a map
 * that fetched nothing while it was being laid out would flash empty on every
 * mount.
 *
 * The *larger* side, where the fitted picture's radius took the smaller: a
 * fit was constrained by the side that decided legibility, and a window shows
 * exactly what each side can hold.
 */
export function radiusForView(view: MapView, box: Box, min: number, max: number): number {
  if (!measured(box) || !Number.isFinite(view.perRoom) || view.perRoom <= 0) return min;
  const upp = unitsPerPixel(view.perRoom);
  const reachX = Math.abs(view.pan.x) + (box.width * upp) / 2;
  const reachY = Math.abs(view.pan.y) + (box.height * upp) / 2;
  const cells = Math.ceil(Math.max(reachX, reachY) / MAP_CELL + 0.5);
  return Math.max(min, Math.min(max, cells));
}

/**
 * How far the placed rooms extend from the centre room, in map units.
 *
 * Off the cells' own grid positions rather than the drawing: `localMap`
 * places the centre at `(0, 0)` and everything else relative to it, which is
 * exactly the frame the pan is stated in. Nothing placed is no extent, and a
 * pan kept inside it is no pan.
 */
export function extentOf(cells: ReadonlyArray<{ gx: number; gy: number }>): Extent {
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  for (const cell of cells) {
    if (cell.gx < minX) minX = cell.gx;
    if (cell.gx > maxX) maxX = cell.gx;
    if (cell.gy < minY) minY = cell.gy;
    if (cell.gy > maxY) maxY = cell.gy;
  }
  return {
    minX: minX * MAP_CELL,
    maxX: maxX * MAP_CELL,
    minY: minY * MAP_CELL,
    maxY: maxY * MAP_CELL
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
