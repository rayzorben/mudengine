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

/** A box in a lane, as laid out. */
export interface LaneBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * The gap the pointer is in, in a lane whose boxes wrap into rows: the rail,
 * where cards stand side by side and the next row starts below (todo 00).
 *
 * The pointer's row is the last whose top it has passed, and every box in an
 * earlier row comes before it. Within its row a box is passed when the
 * pointer is beyond its right edge, or over it and past its midpoint on the
 * lane's own axis: down for the rail, so a one-card row is the old stacked
 * rule, and across for a strip, which is `insertionIndex` over midpoints.
 * Boxes are in reading order.
 */
export function wrappedInsertionIndex(
  boxes: readonly LaneBox[],
  x: number,
  y: number,
  vertical: boolean
): number {
  const tops = [...new Set(boxes.map((box) => box.top))].sort((a, b) => a - b);
  const first = tops[0];
  if (first === undefined) return 0;
  const row = tops.filter((top) => y >= top).pop() ?? first;
  const before = boxes.filter((box) => box.top < row).length;
  const own = boxes.filter((box) => box.top === row);
  if (!vertical)
    return (
      before +
      insertionIndex(
        own.map((box) => (box.left + box.right) / 2),
        x
      )
    );
  const passed = own.filter(
    (box) => x > box.right || (x >= box.left && y > (box.top + box.bottom) / 2)
  ).length;
  return before + passed;
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
