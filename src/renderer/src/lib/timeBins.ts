/**
 * Which of `bins` equal slices of a record's own span a moment falls in: the
 * Alerts card's notices, the Talk card's lines and the Stream card's framed
 * lines, counted for a histogram over time. The span is the record's first
 * moment to its last, so no clock is read; a record of one moment (or none)
 * puts everything in the last slice.
 */
export function timeBin(at: number, first: number, last: number, bins: number): number {
  const span = last - first;
  if (span <= 0) return bins - 1;
  return Math.max(0, Math.min(bins - 1, Math.floor(((at - first) / span) * bins)));
}

/**
 * How many of `items` fall in each of `bins` slices of their span, oldest
 * first. `span` is given when several series share one record's span, as the
 * Alerts card's levels do; otherwise it is the items' own.
 */
export function countByTime<T>(
  items: readonly T[],
  at: (item: T) => number,
  bins: number,
  span?: { first: number; last: number }
): number[] {
  const counts = Array.from({ length: bins }, () => 0);
  const first = span?.first ?? (items.length === 0 ? 0 : at(items[0]!));
  const last = span?.last ?? (items.length === 0 ? 0 : at(items[items.length - 1]!));
  for (const item of items) {
    const bin = timeBin(at(item), first, last, bins);
    counts[bin] = (counts[bin] ?? 0) + 1;
  }
  return counts;
}
