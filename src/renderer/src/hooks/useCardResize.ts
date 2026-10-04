import { useCallback, useMemo, useRef } from 'react';

import {
  LEAST_CARD,
  shippedSize,
  type CardId,
  type CardLayoutApi,
  type RailGridView
} from '../lib/cards';
import { resizedBy, resizedTo, type GridBox } from '../lib/railGrid';
import type { ResizeEdge } from '../lib/resizeEdge';
import { useEdgeDrag, type EdgeGesture } from './useEdgeDrag';

export interface CardResize {
  /** Put on one of a rail card's resize handles. */
  begin(id: CardId, edge: ResizeEdge, event: React.PointerEvent<HTMLElement>): void;
  /** A double-click on a handle: back to the card's shipped size, as far as there is room. */
  reset(id: CardId): void;
}

interface Held {
  id: CardId;
  box: GridBox;
}

/**
 * Resizing a rail card from any corner or side, in whole grid cells (todo 09,
 * todo 01).
 *
 * A rail card is a fixed box that never resizes with its contents, and this
 * is the one way its box changes: by the person looking at it. The box is the
 * card's cells when the handle was taken, with the sides that handle moves
 * carried by how many cells the pointer has travelled since; a handle on the
 * left or top moves the card's spot too. It stops at the cards around it, at
 * the grid's edge and at `LEAST_CARD` (`resizedBy`), so no two cards ever
 * share a cell.
 */
export function useCardResize(
  layout: Pick<CardLayoutApi, 'placeOnRail'>,
  rail: RailGridView
): CardResize {
  // Every placement is a new layout api; through a ref, so `reset` and
  // `begin` hold still for the memoised rail between gestures.
  const live = useRef(layout);
  live.current = layout;

  /** The card in `next`, kept off its neighbours, written down. */
  const place = useCallback(
    (id: CardId, next: (others: GridBox[], columns: number) => GridBox) => {
      const frame = rail.frame();
      if (!frame) return;
      const drawn = rail.drawn();
      const others = [...drawn].filter(([other]) => other !== id).map(([, other]) => other);
      live.current.placeOnRail(id, next(others, frame.columns), drawn);
    },
    [rail]
  );

  const { begin: hold } = useEdgeDrag<Held>(({ edge, x, y, from }: EdgeGesture<Held>, event) => {
    const cell = rail.frame()?.cell;
    if (!cell) return;
    const travel = {
      x: Math.round((event.clientX - x) / cell),
      y: Math.round((event.clientY - y) / cell)
    };
    place(from.id, (others, columns) =>
      resizedBy(from.box, edge, travel, others, columns, LEAST_CARD)
    );
  });

  const begin = useCallback(
    (id: CardId, edge: ResizeEdge, event: React.PointerEvent<HTMLElement>) => {
      const box = rail.drawn().get(id);
      if (box) hold(edge, event, { id, box });
    },
    [hold, rail]
  );

  const reset = useCallback(
    (id: CardId) => {
      const box = rail.drawn().get(id);
      if (!box) return;
      place(id, (others, columns) =>
        resizedTo(box, 'se', shippedSize(id), others, columns, LEAST_CARD)
      );
    },
    [place, rail]
  );

  return useMemo(() => ({ begin, reset }), [begin, reset]);
}
