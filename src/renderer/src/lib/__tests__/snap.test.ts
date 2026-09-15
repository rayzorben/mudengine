import { describe, expect, it } from 'vitest';

import { snapTarget, snappedBox, type SnapBox } from '../snap';

/*
 * Snapping a card over the console to one already there (todo 02,
 * 2026-09-13). The side decides which measurement is copied: above or below
 * takes the target's width, beside takes its height.
 */
const target: SnapBox = { x: 200, y: 100, w: 300, h: 200 };
const within = 24;

describe('where a snapped card lands', () => {
  const dragged: SnapBox = { x: 0, y: 0, w: 120, h: 90 };

  it('takes the target’s height beside it, and keeps its own width', () => {
    expect(snappedBox(dragged, target, 'right')).toEqual({ x: 500, y: 100, w: 120, h: 200 });
    expect(snappedBox(dragged, target, 'left')).toEqual({ x: 80, y: 100, w: 120, h: 200 });
  });

  it('takes the target’s width above and below it, and keeps its own height', () => {
    expect(snappedBox(dragged, target, 'bottom')).toEqual({ x: 200, y: 300, w: 300, h: 90 });
    expect(snappedBox(dragged, target, 'top')).toEqual({ x: 200, y: 10, w: 300, h: 90 });
  });
});

describe('which card is being lined up with', () => {
  const near = (over: Partial<SnapBox>): SnapBox => ({ x: 0, y: 0, w: 120, h: 90, ...over });
  const find = (dragged: SnapBox, neighbours = [{ id: 'room', box: target }]) =>
    snapTarget(dragged, neighbours, within);

  it('snaps to the edge the card’s own edge is nearest', () => {
    // Left edge a few pixels short of the target's right edge, facing it.
    expect(find(near({ x: 510, y: 140 }))?.side).toBe('right');
    // Right edge just past the target's left edge.
    expect(find(near({ x: 90, y: 140 }))?.side).toBe('left');
    expect(find(near({ x: 250, y: 310 }))?.side).toBe('bottom');
    expect(find(near({ x: 250, y: 5 }))?.side).toBe('top');
  });

  /* Slightly over the seam is the same intent as slightly short of it. */
  it('is as forgiving of an overlap as of a gap', () => {
    expect(find(near({ x: 490, y: 140 }))?.side).toBe('right');
    expect(find(near({ x: 512, y: 140 }))?.side).toBe('right');
  });

  it('answers nothing for a card that is merely somewhere else', () => {
    expect(find(near({ x: 560, y: 140 }))).toBeNull();
    expect(find(near({ x: 250, y: 400 }))).toBeNull();
  });

  /*
   * Beside, not past the corner: a card touching only at the corner faces
   * nothing, and snapping it would move it further than the hand did.
   */
  it('refuses a card that only meets the target at its corner', () => {
    // Left edge on the target's right edge, but hanging below all but 10px of it.
    expect(find(near({ x: 505, y: 290 }))).toBeNull();
    // Far enough up to face it properly.
    expect(find(near({ x: 505, y: 260 }))?.side).toBe('right');
  });

  it('takes the nearest edge when two are in reach, and reports where it lands', () => {
    // A card small enough to be within reach of both the left and right edges.
    const narrow: SnapBox = { x: 190, y: 140, w: 20, h: 60 };
    const choice = find(narrow);
    expect(choice?.side).toBe('left');
    expect(choice?.box).toEqual({ x: 180, y: 100, w: 20, h: 200 });
  });

  it('takes the card given first where two are equally near — paint order', () => {
    const other: SnapBox = { x: 200, y: 400, w: 300, h: 200 };
    const between = near({ x: 250, y: 310, h: 80 });
    expect(
      snapTarget(
        between,
        [
          { id: 'first', box: target },
          { id: 'second', box: other }
        ],
        within
      )?.id
    ).toBe('first');
    expect(
      snapTarget(
        between,
        [
          { id: 'second', box: other },
          { id: 'first', box: target }
        ],
        within
      )?.id
    ).toBe('second');
  });

  it('snaps to nothing with no neighbours, no reach, or a neighbour with no box', () => {
    expect(find(near({ x: 510, y: 140 }), [])).toBeNull();
    expect(snapTarget(near({ x: 510, y: 140 }), [{ id: 'room', box: target }], 0)).toBeNull();
    expect(find(near({ x: 510, y: 140 }), [{ id: 'room', box: { ...target, w: 0 } }])).toBeNull();
  });
});
