/**
 * The fullest of a few drawings that fits its box, measured rather than
 * guessed. `mudengine-ui` › parts/cards.md.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Draws tier 0, asks the laid-out element whether it `overflows`, and steps
 * down until it does not or the last of `count` tiers is reached. A resize of
 * the element, or a change to what is `drawn`, starts again from tier 0, so a
 * box that grows gets the fuller drawing back.
 *
 * No pixel constant may exist in this path: a card is resizable, can be docked,
 * floated or railed, and `App.tsx` overwrites the typography tokens at runtime
 * from the config, so a size decided at build time is wrong for somebody.
 */
export function useFitTier<T extends HTMLElement>(
  count: number,
  overflows: (node: T) => boolean,
  drawn: unknown
): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [tier, setTier] = useState(0);

  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setTier(0));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => setTier(0), [drawn]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null || tier >= count - 1) return;
    if (overflows(node)) setTier(tier + 1);
  });

  return [ref, tier];
}
