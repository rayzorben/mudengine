/**
 * Where a dragged thing lands, in a list of things laid out along one axis.
 *
 * Two rules, and both were written twice before this file existed — once in
 * `useCardDrag` for the card rail and once for the tab rail. They are the same
 * arithmetic over the same shape (a run of boxes along one axis, a pointer
 * somewhere among them), and two copies of it drift in exactly the way that is
 * hardest to see: the indicator points at one gap and the drop lands in
 * another, which reads as the drag being wrong rather than as the maths being
 * two different answers.
 *
 * Pure, and tested here rather than through a component, because what is
 * actually delicate is off-by-one at both ends and the fact that a list
 * reordered in place has one fewer slot than it was measured with.
 */

/**
 * The gap the pointer is in: how many midpoints lie before it.
 *
 * Counting the ones already passed is the same answer as "between the two whose
 * midpoints straddle the pointer" and needs no special case for either end —
 * before the first is 0, after the last is `slots.length`.
 *
 * Midpoints rather than edges, so the gap changes when the pointer is halfway
 * across a neighbour rather than the moment it touches it. An indicator that
 * flipped at the seam would flicker between two answers for the whole width of
 * a border.
 */
export function insertionIndex(slots: readonly number[], along: number): number {
  return slots.filter((slot) => along > slot).length;
}

/**
 * The list, with one entry moved to a gap measured against the list as drawn.
 *
 * The subtlety is that `index` counts the gaps of the list **including the
 * entry being moved**, and the list it is being inserted into no longer has it.
 * So a gap after the entry's own place is one too far once it is lifted out,
 * and both of the entry's own two gaps have to come out as no move at all —
 * dropping something back where it was must not renumber the rail.
 *
 * Returns the same array reference when nothing moves, so a caller can tell a
 * real reorder from a click that happened to travel five pixels and not send
 * one.
 */
export function reordered<T>(list: readonly T[], entry: T, index: number): readonly T[] {
  const from = list.indexOf(entry);
  if (from === -1) return list;
  return moved(list, from, index > from ? index - 1 : index);
}

/**
 * The list with the entry at `from` moved to `to`, both counted in the list as
 * it stands. The same array when either is outside it or nothing moves.
 */
export function moved<T>(list: readonly T[], from: number, to: number): readonly T[] {
  const last = list.length - 1;
  if (from === to || from < 0 || to < 0 || from > last || to > last) return list;
  const next = [...list];
  const [entry] = next.splice(from, 1);
  next.splice(to, 0, entry!);
  return next;
}

/** A row's extent along the axis the rows are stacked on. */
export interface RowExtent {
  start: number;
  end: number;
}

/**
 * The place a dragged row takes while the pointer is at `along`.
 *
 * The row moves live, one render per place, so the rule has to hold still
 * after each move: a row goes past a neighbour only once the pointer is past
 * that neighbour's midpoint. With rows of unequal height (a row with a warning
 * under it) a rule on edges would swap the two back on the next pointer event.
 */
export function rowUnderDrag(rows: readonly RowExtent[], from: number, along: number): number {
  const middle = (row: RowExtent): number => (row.start + row.end) / 2;
  for (let at = 0; at < from; at += 1) {
    if (along < middle(rows[at]!)) return at;
  }
  for (let at = rows.length - 1; at > from; at -= 1) {
    if (along > middle(rows[at]!)) return at;
  }
  return from;
}
