/** The rail as laid out now, in px: its height, a grid cell, and the gap between cards. */
export interface RailMeasure {
  rail: number;
  cell: number;
  gap: number;
}

/**
 * A stored card layout from before the rail was a grid (todo 09, 2026-10-03)
 * kept each dragged card's height as `heights`, a fraction of the rail. This
 * turns each into `sizes` in grid cells, the box the card had and the gap
 * under it in whole cells, against the rail as laid out now, and drops the
 * old key. A layout without it comes back as the same
 * object, so the caller can tell a migration from a read.
 *
 * The rail's order carries over as it is: the cards take the first free
 * spots in that order, which is the order they stood in. See `mudengine-ui` ›
 * `parts/cards.md`, *The card rail is a grid*.
 */
export function withGridSizes(
  raw: Record<string, unknown>,
  measure: () => RailMeasure
): Record<string, unknown> {
  if (!('heights' in raw)) return raw;
  const { heights, ...rest } = raw;
  const { rail, cell, gap } = measure();
  const sizes: Record<string, { h: number }> = {};
  if (typeof heights === 'object' && heights !== null && rail > 0 && cell > 0) {
    for (const [id, fraction] of Object.entries(heights as Record<string, unknown>)) {
      if (typeof fraction === 'number' && Number.isFinite(fraction)) {
        sizes[id] = { h: Math.round((fraction * rail + gap) / cell) };
      }
    }
  }
  return { ...rest, sizes };
}
