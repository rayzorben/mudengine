/**
 * The eight places a card's box is taken hold of to resize it (todo 01,
 * 2026-10-03): its four corners and its four sides, named by the compass
 * codes the realm's exits use. A rail card and a float share the names, the
 * handles that draw them and the arithmetic of which sides move. See
 * `mudengine-ui` › `parts/cards.md`, *The card rail is a grid*.
 */

import type { FloatBox } from './cards';

/** Every handle, corners first so they paint over the sides they meet. */
export const RESIZE_EDGES = ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'] as const;

export type ResizeEdge = (typeof RESIZE_EDGES)[number];

/** Which side of a box an axis moves: -1 the left or top, 1 the right or bottom, 0 neither. */
export type Side = -1 | 0 | 1;

export interface Sides {
  x: Side;
  y: Side;
}

/** A `Record` over the union, so a new handle cannot be added without saying what it moves. */
const SIDES: Record<ResizeEdge, Sides> = {
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
  nw: { x: -1, y: -1 }
};

export function sidesOf(edge: ResizeEdge): Sides {
  return SIDES[edge];
}

/** A box as a start and a length along one axis. */
export interface Span {
  start: number;
  length: number;
}

/**
 * One axis of a box after a handle has travelled `by` along it: the side the
 * handle moves goes with the pointer and the other side stays where it is.
 * The length never goes under `least` and the box never leaves `0..limit`.
 */
function stretchedSpan(span: Span, side: Side, by: number, least: number, limit: number): Span {
  if (side === 0) return span;
  if (side === 1) {
    const room = Math.max(least, limit - span.start);
    return { start: span.start, length: Math.min(room, Math.max(least, span.length + by)) };
  }
  const end = span.start + span.length;
  const start = Math.max(0, Math.min(end - least, span.start + by));
  return { start, length: end - start };
}

/**
 * A float's box after its `edge` handle has travelled `by`, in fractions of
 * the workspace: never smaller than `least` and never outside the workspace
 * on the sides that move. Pulling the left or top side moves the box's
 * corner as well as its size, and the opposite side stays put.
 */
export function stretched(
  box: FloatBox,
  edge: ResizeEdge,
  by: { x: number; y: number },
  least: { w: number; h: number }
): FloatBox {
  const sides = sidesOf(edge);
  const across = stretchedSpan({ start: box.x, length: box.w }, sides.x, by.x, least.w, 1);
  const down = stretchedSpan({ start: box.y, length: box.h }, sides.y, by.y, least.h, 1);
  return { x: across.start, y: down.start, w: across.length, h: down.length };
}
