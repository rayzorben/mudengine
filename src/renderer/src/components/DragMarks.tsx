/**
 * What a drag puts over the window while it is in flight: the ghost of what
 * was picked up, and the landing box where releasing it beside another float
 * puts it. The rail's landing box is the grid's own (`RailGrid`) and a
 * strip's is its gap (`StripCards`).
 */
import { memo } from 'react';

import type { DragState } from '../hooks/useCardDrag';
import { cardLabel } from '../lib/cards';

export interface DragMarksProps {
  state: DragState | null;
  /** The card in hand is a float, which follows the pointer itself and needs no ghost. */
  floating: boolean;
}

function DragMarks({ state, floating }: DragMarksProps) {
  if (!state?.live) return null;
  const { target } = state;
  return (
    <>
      {/*
        Where a released card would land, beside the one it is being lined up
        with: the landing box itself, drawn where the card will be and at the
        size it will take. A bar along the seam would say which edge and not
        what happens to the card, and the whole point of the gesture is that
        the card takes its neighbour's measurement across that edge.
      */}
      {target.where === 'snap' && (
        <div
          className="snap-indicator"
          /* Which card, and which of its edges — the two facts the box's own
             geometry does not state outright, for a person inspecting the
             window and for the check that drives the gesture. */
          data-side={target.side}
          data-snap-to={target.to}
          style={{
            left: target.box.x,
            top: target.box.y,
            width: target.box.w,
            height: target.box.h
          }}
        />
      )}
      {/*
        What is being dragged, following the pointer, in its own shape. A
        ghost rather than the card itself: moving the real node would collapse
        the place it leaves and shift every measurement the drop target is
        computed from. The ghost is the size of what was picked up, the card's
        box or a put-away card's chip, held where the pointer took hold of it,
        so the card is felt to move rather than a label to appear.
      */}
      {!floating && (
        <div
          className="drag-ghost"
          data-shape={state.shape}
          style={{
            left: state.x - state.grab.dx,
            top: state.y - state.grab.dy,
            ...(state.size.w > 0 ? { width: state.size.w } : {}),
            ...(state.size.h > 0 ? { height: state.size.h } : {})
          }}
        >
          {cardLabel(state.id)}
        </div>
      )}
    </>
  );
}

export default memo(DragMarks);
