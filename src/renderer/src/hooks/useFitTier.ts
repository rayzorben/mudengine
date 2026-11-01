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
  drawn: string
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

  /*
   * One effect both restarts and steps. As two, a change to `drawn` queued tier
   * 0 and then, from the same commit's stale tier, tier + 1; the later update
   * won, so the box skipped straight to a smaller drawing than it needed.
   */
  const measured = useRef(drawn);
  useLayoutEffect(() => {
    if (!Object.is(measured.current, drawn)) {
      measured.current = drawn;
      if (tier !== 0) {
        setTier(0);
        return;
      }
    }
    const node = ref.current;
    if (node === null || tier >= count - 1) return;
    if (overflows(node)) setTier(tier + 1);
  });

  return [ref, tier];
}
