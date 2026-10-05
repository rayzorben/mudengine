import { inReadingOrder, NARROWEST_RAIL } from './railCards';
import type { GridSpot } from './railGrid';

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

/**
 * The size each card stood at before it had a preferred box (todo 06,
 * 2026-10-05), in cells: rows, and 17 across but for the four tables that
 * needed 20. A ledger of what was drawn then, for the layouts kept then.
 */
const BEFORE_PREFERRED: Record<string, [rows: number, across?: number]> = {
  toolbar: [4],
  self: [21, 20],
  vitals: [13],
  combat: [13],
  room: [14],
  map: [25],
  builder: [33],
  navigation: [14],
  party: [14],
  notifications: [15],
  realm: [14],
  players: [14],
  gang: [13],
  inventory: [14, 20],
  banks: [12],
  shops: [14, 20],
  quests: [27, 20],
  hunting: [13],
  conversation: [15],
  reference: [13],
  stats: [13],
  extension: [31],
  session: [13],
  link: [14],
  automation: [14],
  stream: [15]
};

/**
 * A stored card layout from before it kept the width of the rail its spots
 * and sizes are cells of (todo 06, 2026-10-05). This adds that width, read
 * as the arrangement's own right edge: the rails it was taken from were
 * arranged to fill it. A card with a spot and no size is given the size it
 * was drawn at then, so the arrangement is drawn as it was rather than at
 * the preferred sizes, and the rail's order is put in reading order, which a
 * stacked rail draws. A layout with nothing to add comes back as the same
 * object.
 */
export function withRailColumns(raw: Record<string, unknown>): Record<string, unknown> {
  if (typeof raw['columns'] === 'number') return raw;
  const spots = entries(raw['spots']);
  const sizes = entries(raw['sizes']);
  if (Object.keys(spots).length === 0 && Object.keys(sizes).length === 0) return raw;
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const given: Record<string, Record<string, unknown>> = { ...sizes };
  for (const id of Object.keys(spots)) {
    const before = BEFORE_PREFERRED[id];
    if (given[id] === undefined && before !== undefined) {
      given[id] = { w: before[1] ?? NARROWEST_RAIL, h: before[0] };
    }
  }
  const edges = [
    NARROWEST_RAIL,
    ...Object.entries(spots).map(
      ([id, spot]) => (number(spot['x']) ?? 0) + (number(given[id]?.['w']) ?? NARROWEST_RAIL)
    ),
    ...Object.values(given).map((size) => number(size['w']) ?? 0)
  ];
  const placed: Record<string, GridSpot> = {};
  for (const [id, spot] of Object.entries(spots)) {
    const x = number(spot['x']);
    const y = number(spot['y']);
    if (x !== null && y !== null) placed[id] = { x, y };
  }
  const order = Array.isArray(raw['rail'])
    ? inReadingOrder(
        (raw['rail'] as unknown[]).filter((id) => typeof id === 'string'),
        placed
      )
    : raw['rail'];
  return { ...raw, rail: order, sizes: given, columns: Math.round(Math.max(...edges)) };
}

/** A stored block of entries keyed by card, as far as each is an object. */
function entries(value: unknown): Record<string, Record<string, unknown>> {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        typeof entry[1] === 'object' && entry[1] !== null
    )
  );
}
