/**
 * The size a card is drawn at (`lib/cardSize.ts`): measured once per card by
 * `BentoCard` and handed to everything inside it through context, so a face
 * asks `useCardSize()` instead of measuring itself.
 */
import { createContext, useContext, useLayoutEffect, useState, type RefObject } from 'react';

import { cardSizeBounds, cardSizeOf, type CardSize } from '../lib/cardSize';

/*
 * Outside any card (a flyout, a popover drawing a card's table) there is no
 * box to fit, so everything is drawn.
 */
export const CardSizeContext = createContext<CardSize>('large');

/** The size of the card this is drawn inside. */
export function useCardSize(): CardSize {
  return useContext(CardSizeContext);
}

/**
 * Measures the card's box under a `ResizeObserver`. Null until measured.
 *
 * A rolled card keeps the size it had: its box is its heading, and redrawing
 * the hidden body small would flash the small design on the way back down.
 */
export function useMeasuredCardSize(
  frame: RefObject<HTMLElement | null>,
  rolled: boolean
): CardSize | null {
  const [size, setSize] = useState<CardSize | null>(null);

  useLayoutEffect(() => {
    const card = frame.current;
    if (!card || rolled) return;
    const measure = (): void => {
      const bounds = cardSizeBounds(card);
      if (bounds === null) return;
      const next = cardSizeOf(card.getBoundingClientRect(), bounds);
      if (next !== null) setSize(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, [frame, rolled]);

  return size;
}
