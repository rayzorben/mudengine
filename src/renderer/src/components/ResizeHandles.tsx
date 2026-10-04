/**
 * The handles a card's box is resized by (todo 01, 2026-10-03): one on each
 * corner and each side, drawn over the box's own edge and the gutter beside
 * it, so the card's body, its scrollbar, its heading and its action column
 * keep the pointer. Corners carry a quiet mark while the card is pointed at;
 * a side shows a short seam under the pointer. Each has the cursor for the
 * way it moves (`data-edge`). See `mudengine-ui` › `parts/cards.md`.
 */
import { memo } from 'react';

import type { CardId } from '../lib/cards';
import { RESIZE_EDGES, type ResizeEdge } from '../lib/resizeEdge';

export interface ResizeHandlesProps {
  card: CardId;
  /** Takes the card, so one callback serves every card and the memo holds. */
  onGrab(card: CardId, edge: ResizeEdge, event: React.PointerEvent<HTMLElement>): void;
  /** A double-click on any handle, where the placement has a size to go back to. */
  onReset?(card: CardId): void;
  title: string;
}

function ResizeHandles({ card, onGrab, onReset, title }: ResizeHandlesProps) {
  return (
    <div className="resize-frame">
      {RESIZE_EDGES.map((edge) => (
        <span
          aria-hidden="true"
          className="resize-handle"
          data-edge={edge}
          key={edge}
          onDoubleClick={onReset && (() => onReset(card))}
          onPointerDown={(event) => onGrab(card, edge, event)}
          title={title}
        />
      ))}
    </div>
  );
}

export default memo(ResizeHandles);
