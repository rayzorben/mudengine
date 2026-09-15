/**
 * Where a dragged card lands when it is released beside another one.
 *
 * A card left over the console has free geometry — a position and a size that
 * are nobody's but the player's — and two of them put side by side almost
 * never line up: a few pixels of gap, a few pixels of overlap, and two cards
 * that are meant to read as one column stand slightly wrong for the rest of
 * the evening. Snapping is the answer the rail already gives for stacking
 * (drop between two cards and they close up) applied to the one placement
 * that has no lane to line up in.
 *
 * **The side decides which dimension is copied**, and that is the whole rule:
 * a card dropped above or below another takes its *width*, one dropped left or
 * right takes its *height*. What is snapped to never moves or resizes — the
 * card in the hand is the one being arranged.
 *
 * Here rather than in `useCardDrag` for the reason `lib/reorder.ts` and
 * `lib/splitter.ts` are: this is where the edge cases are — which side, how
 * near counts as near, how much overlap is beside rather than past — and a
 * decision inside a pointer handler can only be tested by driving a pointer.
 *
 * Unit-agnostic: every box in one call must be in the same units. The drag
 * hit-tests in client pixels, because that is what a pointer and a
 * `getBoundingClientRect` are in, and converts the landing box to fractions of
 * the workspace at the moment it commits — floats are stored as fractions so
 * the arrangement survives a resize (`FloatLayer`).
 */

export type SnapSide = 'top' | 'bottom' | 'left' | 'right';

export interface SnapBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A card that could be snapped to, and where it is. */
export interface SnapNeighbour<Id> {
  id: Id;
  box: SnapBox;
}

/** The card the pointer is beside, which side of it, and where that lands. */
export interface SnapChoice<Id> {
  id: Id;
  side: SnapSide;
  /** Where the dragged card ends up. Same units as the boxes it was found from. */
  box: SnapBox;
}

/** How far two spans overlap along one axis; zero or less is no overlap. */
function overlap(from: number, span: number, otherFrom: number, otherSpan: number): number {
  return Math.min(from + span, otherFrom + otherSpan) - Math.max(from, otherFrom);
}

/**
 * Where the dragged card sits once it is snapped to that side of the target.
 *
 * Flush against the edge, aligned with the target's near corner, and taking
 * the target's measurement across the shared edge: a card under another is as
 * wide as it, a card beside another is as tall. The dimension along the snap
 * is the dragged card's own and is kept — snapping arranges a card, it does
 * not resize it in both directions.
 */
export function snappedBox(dragged: SnapBox, target: SnapBox, side: SnapSide): SnapBox {
  switch (side) {
    case 'right':
      return { x: target.x + target.w, y: target.y, w: dragged.w, h: target.h };
    case 'left':
      return { x: target.x - dragged.w, y: target.y, w: dragged.w, h: target.h };
    case 'bottom':
      return { x: target.x, y: target.y + target.h, w: target.w, h: dragged.h };
    case 'top':
      return { x: target.x, y: target.y - dragged.h, w: target.w, h: dragged.h };
  }
}

/**
 * The nearest card the dragged one would snap to, or null for a drag that is
 * beside nothing.
 *
 * A side is a candidate when the dragged card's own edge is within `within` of
 * the target's opposite edge — in either direction, so a card nudged slightly
 * *over* the seam snaps as readily as one left slightly short — **and** the two
 * overlap across that edge by at least `within` as well. One number for both,
 * deliberately: *beside* and *past the corner* differ by whether the cards face
 * each other at all, and a second constant would be a second thing to tune to
 * make one gesture feel right. A card touching another only at the corner is
 * not beside it.
 *
 * Nearest gap wins; a tie goes to the neighbour given first, which is paint
 * order, so the card on top is the one a player thinks they are aiming at.
 */
export function snapTarget<Id>(
  dragged: SnapBox,
  neighbours: ReadonlyArray<SnapNeighbour<Id>>,
  within: number
): SnapChoice<Id> | null {
  if (within <= 0) return null;
  let best: { choice: SnapChoice<Id>; gap: number } | null = null;
  for (const neighbour of neighbours) {
    const target = neighbour.box;
    if (target.w <= 0 || target.h <= 0) continue;
    const across = {
      // Left and right share the vertical extent; top and bottom the horizontal.
      vertical: overlap(dragged.y, dragged.h, target.y, target.h),
      horizontal: overlap(dragged.x, dragged.w, target.x, target.w)
    };
    const sides: Array<[SnapSide, number, number]> = [
      ['right', Math.abs(dragged.x - (target.x + target.w)), across.vertical],
      ['left', Math.abs(dragged.x + dragged.w - target.x), across.vertical],
      ['bottom', Math.abs(dragged.y - (target.y + target.h)), across.horizontal],
      ['top', Math.abs(dragged.y + dragged.h - target.y), across.horizontal]
    ];
    for (const [side, gap, shared] of sides) {
      if (gap > within || shared < within) continue;
      if (best !== null && gap >= best.gap) continue;
      best = { choice: { id: neighbour.id, side, box: snappedBox(dragged, target, side) }, gap };
    }
  }
  return best?.choice ?? null;
}
