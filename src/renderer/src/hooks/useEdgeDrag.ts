import { useCallback, useEffect, useRef, useState } from 'react';

import type { ResizeEdge } from '../lib/resizeEdge';

/** A resize handle held: which one, where the pointer took it, and the box then. */
export interface EdgeGesture<T> {
  edge: ResizeEdge;
  x: number;
  y: number;
  from: T;
}

export interface EdgeDrag<T> {
  /** Put on a handle's pointerdown, with the box as it stands. */
  begin(edge: ResizeEdge, event: React.PointerEvent<HTMLElement>, from: T): void;
}

/**
 * Holding one of a card's resize handles (todo 01, 2026-10-03), for the rail
 * and the floats alike. Every move hands `move` the gesture as it was taken
 * and the pointer now, so the size is worked out from where the handle was
 * taken and a drag that overshoots and comes back lands under the pointer.
 *
 * While a handle is held the document wears its cursor
 * (`data-resize-edge`), so the cursor does not flicker back to an arrow when
 * the pointer runs ahead of a handle that stops at a neighbour.
 */
export function useEdgeDrag<T>(
  move: (gesture: EdgeGesture<T>, event: PointerEvent) => void
): EdgeDrag<T> {
  const [active, setActive] = useState<EdgeGesture<T> | null>(null);
  /*
   * Read through a ref: a move writes the layout, every write is a new
   * layout api, and an effect depending on it would tear its window
   * listeners down and reattach them on every pointermove of the gesture.
   */
  const live = useRef(move);
  live.current = move;

  const begin = useCallback((edge: ResizeEdge, event: React.PointerEvent<HTMLElement>, from: T) => {
    if (event.button !== 0) return;
    // Refuses the caret as well as the browser's own drag, as the card
    // heading does: a handle is dragged, never typed into.
    event.preventDefault();
    event.stopPropagation();
    setActive({ edge, x: event.clientX, y: event.clientY, from });
  }, []);

  useEffect(() => {
    if (active === null) return;
    const root = document.documentElement;
    root.dataset['resizeEdge'] = active.edge;
    const onMove = (event: PointerEvent): void => live.current(active, event);
    const stop = (): void => setActive(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      delete root.dataset['resizeEdge'];
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [active]);

  return { begin };
}
