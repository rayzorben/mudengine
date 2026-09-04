import { useCallback, useEffect, useRef, useState } from 'react';

import type { CardId, CardLayoutApi } from './useCardLayout';

export interface CardResize {
  /** The card being resized, while the grip is held. */
  active: CardId | null;
  /** Put on a rail card's corner grip. */
  begin(id: CardId, event: React.PointerEvent<HTMLElement>): void;
}

interface Gesture {
  id: CardId;
  /** The card's top edge and the rail's height, measured once, when the grip is taken. */
  top: number;
  rail: number;
}

/**
 * Dragging a rail card's corner to change how tall it is.
 *
 * A rail card is a fixed box that never resizes with its contents, and this
 * is the one way its box changes: by the person looking at it. The same
 * gesture a float's corner grip makes, with one axis — a rail card's width is
 * the rail's, and the rail has its own splitter.
 *
 * Sized from where the pointer *is* rather than from an accumulated delta, so
 * a drag that overshoots and comes back lands under the pointer instead of
 * drifting away from it — and stored as a **fraction of the rail**, measured
 * when the grip is taken, because nothing in the layout path may hold a pixel
 * figure. The card's top and the rail's height are read once per gesture:
 * neither moves while the grip is held.
 */
export function useCardResize(layout: CardLayoutApi): CardResize {
  const [active, setActive] = useState<CardId | null>(null);
  const gesture = useRef<Gesture | null>(null);
  /*
   * What the move handler reads, carried outside the effect's dependencies.
   * Every `sizeRail` produces a new layout api, so an effect depending on
   * `layout` would tear its window listeners down and reattach them on every
   * pointermove of the very gesture they serve.
   */
  const live = useRef(layout);
  live.current = layout;

  const begin = useCallback((id: CardId, event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const card = event.currentTarget.closest<HTMLElement>('[data-card]');
    const rail = card?.closest<HTMLElement>('.rail');
    if (!card || !rail) return;
    const box = card.getBoundingClientRect();
    const lane = rail.getBoundingClientRect();
    if (lane.height <= 0) return;
    // Refuses the caret as well as the browser's own drag, exactly as the
    // card header does: a grip is dragged, never typed into.
    event.preventDefault();
    event.stopPropagation();
    gesture.current = { id, top: box.top, rail: lane.height };
    setActive(id);
  }, []);

  useEffect(() => {
    if (active === null) return;
    const move = (event: PointerEvent): void => {
      const at = gesture.current;
      if (!at) return;
      live.current.sizeRail(at.id, (event.clientY - at.top) / at.rail);
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
  }, [active]);

  return { active, begin };
}
