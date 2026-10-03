/**
 * The cards in a strip docked to the console, left to right, with a gap the
 * dragged card's own size opened where a drop would land.
 *
 * A gap rather than a line, so the cards beside it move out of the way and
 * the card is *felt* to move before it is dropped. It is not drawn where the
 * drop would change nothing: there the dimmed card itself is the gap, and a
 * second box beside it would read as two places for one card. `reordered` is
 * the same arithmetic the drop commits with, so the two cannot disagree about
 * which drops are no move. The rail is a grid, drawn by `RailGrid`.
 */
import { Fragment, memo, type CSSProperties, type ReactNode } from 'react';

import type { DragState } from '../hooks/useCardDrag';
import type { CardId, Strip } from '../lib/cards';
import { reordered } from '../lib/reorder';

export interface StripCardsProps {
  strip: Strip;
  ids: readonly CardId[];
  render(id: CardId): ReactNode;
  drag: DragState | null;
}

function StripCards({ strip, ids, render, drag }: StripCardsProps) {
  const at =
    drag?.live && drag.target.where === 'lane' && drag.target.lane === strip
      ? drag.target.index
      : null;
  const noMove =
    at !== null && drag !== null && ids.includes(drag.id) && reordered(ids, drag.id, at) === ids;
  const slot =
    at !== null && drag !== null && !noMove ? (
      <div
        className="rail-slot"
        data-shape={drag.shape}
        style={
          drag.shape === 'card'
            ? ({ '--slot-w': `${drag.size.w}px`, '--slot-h': `${drag.size.h}px` } as CSSProperties)
            : undefined
        }
      />
    ) : null;
  return (
    <>
      {ids.map((id, index) => {
        const card = render(id);
        if (card === null) return null;
        return (
          <Fragment key={id}>
            {at === index && slot}
            {card}
          </Fragment>
        );
      })}
      {/* The gap at the very end, which no card precedes. */}
      {at !== null && at >= ids.length && slot}
    </>
  );
}

export default memo(StripCards);
