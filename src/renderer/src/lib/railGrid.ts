/**
 * The card rail as a grid of square cells (todo 09, 2026-10-03): where each
 * card stands, measured in whole cells, and the rule that no two overlap.
 * Every placement the rail draws, every drop and every resize goes
 * through here, so the picture and the stored arrangement cannot disagree.
 *
 * Pure and tested without a DOM. The cell's size and why it is that size are
 * in `mudengine-ui` › `parts/cards.md`, *The card rail is a grid*.
 */

import { sidesOf, type ResizeEdge, type Side, type Span } from './resizeEdge';

/** Where a card's top-left corner is, in cells from the grid's own corner. */
export interface GridSpot {
  x: number;
  y: number;
}

/** How many cells a card spans across and down. */
export interface GridSize {
  w: number;
  h: number;
}

export type GridBox = GridSpot & GridSize;

/**
 * One card to arrange: its size, and where it was put, if it has been. A card
 * nobody has placed yet (one just shown, or one a later build added) takes
 * the first free spot.
 */
export interface GridCard<Id> {
  id: Id;
  size: GridSize;
  spot?: GridSpot;
}

/** Whether two boxes are the same cells. */
export function sameBox(a: GridBox, b: GridBox): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Whether two boxes share a cell. Touching edges do not. */
export function overlaps(a: GridBox, b: GridBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function isFree(box: GridBox, taken: readonly GridBox[]): boolean {
  return taken.every((other) => !overlaps(box, other));
}

/**
 * A box brought inside a grid `columns` wide: no wider than the grid, moved
 * left until its right edge is in it, and never above or left of the corner.
 * Whole cells, so a stored figure from a hand edit cannot put a card between
 * two cells.
 */
export function fitted(box: GridBox, columns: number): GridBox {
  const across = Math.max(1, Math.floor(columns));
  const w = Math.min(across, Math.max(1, Math.round(box.w)));
  const h = Math.max(1, Math.round(box.h));
  const x = Math.min(across - w, Math.max(0, Math.round(box.x)));
  const y = Math.max(0, Math.round(box.y));
  return { x, y, w, h };
}

/** The first row under every box, which is always free. */
export function bottomOf(boxes: Iterable<GridBox>): number {
  let bottom = 0;
  for (const box of boxes) bottom = Math.max(bottom, box.y + box.h);
  return bottom;
}

/**
 * The first free spot for a card of this size, reading the grid as a page:
 * the highest row, then the leftmost cell. Only the grid's left edge and the
 * right and bottom edges of what is already there can be a first free spot,
 * so only those are tried.
 */
export function firstFree(size: GridSize, taken: readonly GridBox[], columns: number): GridBox {
  const { w, h } = fitted({ x: 0, y: 0, ...size }, columns);
  const xs = [0, ...taken.map((box) => box.x + box.w)];
  const ys = [0, ...taken.map((box) => box.y + box.h)];
  const spots = ys
    .flatMap((y) => xs.map((x) => ({ x, y })))
    .filter((spot) => spot.x + w <= columns)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const spot of spots) {
    const box = { ...spot, w, h };
    if (isFree(box, taken)) return box;
  }
  return { x: 0, y: bottomOf(taken), w, h };
}

/**
 * Where every card is drawn, in a grid `columns` wide.
 *
 * The placed cards first, top row first, each brought inside the grid and,
 * where a narrower window has pushed it onto another, moved down until it is
 * clear. Then the unplaced ones, in the order given, each at the first free
 * spot. No two boxes in the answer overlap, whatever was stored.
 */
export function arrange<Id>(cards: readonly GridCard<Id>[], columns: number): Map<Id, GridBox> {
  const out = new Map<Id, GridBox>();
  const taken: GridBox[] = [];
  const placed = cards
    .filter((card) => card.spot !== undefined)
    .map((card, order) => ({ card, order, box: fitted({ ...card.spot!, ...card.size }, columns) }))
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x || a.order - b.order);
  for (const { card, box } of placed) {
    let at = box;
    for (;;) {
      const blocking = taken.filter((other) => overlaps(at, other));
      if (blocking.length === 0) break;
      at = { ...at, y: bottomOf(blocking) };
    }
    taken.push(at);
    out.set(card.id, at);
  }
  for (const card of cards) {
    if (card.spot !== undefined) continue;
    const box = firstFree(card.size, taken, columns);
    taken.push(box);
    out.set(card.id, box);
  }
  return out;
}

/**
 * The free spot nearest to where a card is wanted, for a card of the wanted
 * box's size: the wanted spot itself when nothing is there, else the closest
 * one by straight-line distance, the higher and then the further left on a
 * tie. Rows are searched outwards from the wanted one and the search stops
 * once a row is further away than the best spot found, so a long rail costs
 * the rows near the pointer and not the whole grid.
 */
export function nearestFree(wanted: GridBox, taken: readonly GridBox[], columns: number): GridBox {
  const box = fitted(wanted, columns);
  if (isFree(box, taken)) return box;
  const last = Math.max(box.y, bottomOf(taken));
  let best: GridBox | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let d = 0; d * d <= bestDistance && d <= last; d += 1) {
    for (const y of d === 0 ? [box.y] : [box.y - d, box.y + d]) {
      if (y < 0 || y > last) continue;
      for (let x = 0; x + box.w <= columns; x += 1) {
        const distance = (x - box.x) ** 2 + d * d;
        const better =
          distance < bestDistance ||
          (distance === bestDistance &&
            best !== null &&
            (y < best.y || (y === best.y && x < best.x)));
        if (!better) continue;
        const candidate: GridBox = { x, y, w: box.w, h: box.h };
        if (!isFree(candidate, taken)) continue;
        best = candidate;
        bestDistance = distance;
      }
    }
  }
  return best ?? { ...box, y: bottomOf(taken) };
}

/**
 * One axis of a box resized from `side` towards `wanted` cells: the side
 * held stays where it is, and the side moved stops at the first length that
 * is `free`, at `room` (the grid's edge) and at `least`.
 */
function settled(
  span: Span,
  side: Side,
  wanted: number,
  least: number,
  limit: number,
  free: (span: Span) => boolean
): Span {
  if (side === 0) return span;
  const end = span.start + span.length;
  const room = side === 1 ? limit - span.start : end;
  const at = (length: number): Span =>
    side === 1 ? { start: span.start, length } : { start: end - length, length };
  const lo = Math.min(least, room);
  const hi = Math.max(lo, Math.min(Math.round(wanted), room));
  for (let n = hi; n > lo; n -= 1) if (free(at(n))) return at(n);
  return at(lo);
}

/**
 * A card's box after its `edge` handle is dragged until the card is `wanted`
 * cells, kept on the grid and off its neighbours. The side opposite the
 * handle stays put, so a handle on the left or top moves the card's spot as
 * well as its size. The width is settled first, at the card's present height
 * (or the smaller one wanted), then the height at that width; each stops at
 * the nearest card in its way, at the grid's edge, and at `least`.
 */
export function resizedTo(
  box: GridBox,
  edge: ResizeEdge,
  wanted: GridSize,
  taken: readonly GridBox[],
  columns: number,
  least: GridSize
): GridBox {
  const sides = sidesOf(edge);
  const down: Span = { start: box.y, length: box.h };
  const held =
    sides.y === 0
      ? down
      : settled(
          down,
          sides.y,
          Math.min(box.h, Math.max(least.h, Math.round(wanted.h))),
          least.h,
          Infinity,
          () => true
        );
  const across = settled(
    { start: box.x, length: box.w },
    sides.x,
    wanted.w,
    least.w,
    columns,
    (s) => isFree({ x: s.start, w: s.length, y: held.start, h: held.length }, taken)
  );
  const rows = settled(down, sides.y, wanted.h, least.h, Infinity, (s) =>
    isFree({ x: across.start, w: across.length, y: s.start, h: s.length }, taken)
  );
  return { x: across.start, y: rows.start, w: across.length, h: rows.length };
}

/**
 * A card's box after its `edge` handle has travelled `travel` whole cells
 * from where it was taken: the travel says how far the moving sides go, and
 * `resizedTo` keeps the result on the grid and off its neighbours.
 */
export function resizedBy(
  box: GridBox,
  edge: ResizeEdge,
  travel: GridSpot,
  taken: readonly GridBox[],
  columns: number,
  least: GridSize
): GridBox {
  const sides = sidesOf(edge);
  const wanted = { w: box.w + sides.x * travel.x, h: box.h + sides.y * travel.y };
  return resizedTo(box, edge, wanted, taken, columns, least);
}
