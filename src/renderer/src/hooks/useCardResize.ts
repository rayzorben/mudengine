import { useCallback, useEffect, useRef, useState } from 'react';

import {
  LEAST_CARD,
  shippedSize,
  type CardId,
  type CardLayoutApi,
  type RailGridView
} from '../lib/cards';
import { resizedWithin, type GridBox, type GridSize } from '../lib/railGrid';

export interface CardResize {
  /** The card being resized, while the grip is held. */
  active: CardId | null;
  /** Put on a rail card's corner grip. */
  begin(id: CardId, event: React.PointerEvent<HTMLElement>): void;
  /** A double-click on the grip: back to the card's shipped size, as far as there is room. */
  reset(id: CardId): void;
}

interface Gesture {
  id: CardId;
  /** Where the pointer took the grip, and the card's cells then. */
  x: number;
  y: number;
  box: GridBox;
}

/**
 * Dragging a rail card's corner to change its size, in whole grid cells
 * (todo 09).
 *
 * A rail card is a fixed box that never resizes with its contents, and this
 * is the one way its box changes: by the person looking at it. The size is
 * the card's cells when the grip was taken plus how many cells the pointer
 * has travelled since, so a drag that overshoots and comes back lands under
 * the pointer rather than drifting; and it stops at the card beside or below
 * it, at the grid's edge and at `LEAST_CARD` (`resizedWithin`), so no two
 * cards ever share a cell.
 */
export function useCardResize(layout: CardLayoutApi, rail: RailGridView): CardResize {
  const [active, setActive] = useState<CardId | null>(null);
  const gesture = useRef<Gesture | null>(null);
  /*
   * What the move handler reads, carried outside the effect's dependencies.
   * Every placement produces a new layout api, so an effect depending on
   * `layout` would tear its window listeners down and reattach them on every
   * pointermove of the very gesture they serve.
   */
  const live = useRef(layout);
  live.current = layout;

  /** The card at `wanted` cells, kept off its neighbours, written down. */
  const size = useCallback(
    (id: CardId, box: GridBox, wanted: GridSize) => {
      const frame = rail.frame();
      if (!frame) return;
      const drawn = rail.drawn();
      const others = [...drawn].filter(([other]) => other !== id).map(([, other]) => other);
      const next = resizedWithin(box, wanted, others, frame.columns, LEAST_CARD);
      live.current.placeOnRail(id, next, drawn);
    },
    [rail]
  );

  const begin = useCallback(
    (id: CardId, event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const box = rail.drawn().get(id);
      if (!box) return;
      // Refuses the caret as well as the browser's own drag, exactly as the
      // card header does: a grip is dragged, never typed into.
      event.preventDefault();
      event.stopPropagation();
      gesture.current = { id, x: event.clientX, y: event.clientY, box };
      setActive(id);
    },
    [rail]
  );

  const reset = useCallback(
    (id: CardId) => {
      const box = rail.drawn().get(id);
      if (box) size(id, box, shippedSize(id));
    },
    [rail, size]
  );

  useEffect(() => {
    if (active === null) return;
    const move = (event: PointerEvent): void => {
      const at = gesture.current;
      const frame = rail.frame();
      if (!at || !frame) return;
      size(at.id, at.box, {
        w: at.box.w + Math.round((event.clientX - at.x) / frame.cell),
        h: at.box.h + Math.round((event.clientY - at.y) / frame.cell)
      });
    };
    const stop = (): void => {
      gesture.current = null;
      setActive(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [active, rail, size]);

  return { active, begin, reset };
}
