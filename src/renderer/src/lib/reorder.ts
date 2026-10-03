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

/** A box in a lane that wraps: where its line starts across, its midpoint along. */
export interface WrappedSlot {
  /** The start of its line on the cross axis: a column's left edge on the rail. */
  line: number;
  /** Its midpoint on the lane's own axis. */
  along: number;
}

/**
 * The gap the pointer is in, in a lane whose boxes wrap into lines: the rail,
 * where a column fills to the rail's height and the next card starts the next
 * column (todo 00).
 *
 * The pointer's line is the last whose start it has passed, and within it the
 * gap is `insertionIndex` over that line's midpoints; every box in an earlier
 * line comes before it. Boxes are in reading order, so a line's boxes are
 * consecutive. One line is exactly `insertionIndex`.
 */
export function wrappedInsertionIndex(
  slots: readonly WrappedSlot[],
  along: number,
  across: number
): number {
  const starts = [...new Set(slots.map((slot) => slot.line))].sort((a, b) => a - b);
  const first = starts[0];
  if (first === undefined) return 0;
  const line = starts.filter((start) => across >= start).pop() ?? first;
  const before = slots.filter((slot) => slot.line < line).length;
  const own = slots.filter((slot) => slot.line === line).map((slot) => slot.along);
  return before + insertionIndex(own, along);
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
  const to = index > from ? index - 1 : index;
  if (to === from || to < 0 || to > list.length - 1) return list;
  const next = [...list];
  next.splice(from, 1);
  next.splice(to, 0, entry);
  return next;
}
