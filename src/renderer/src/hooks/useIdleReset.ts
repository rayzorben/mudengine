/**
 * A hold that lets go on its own: while `active`, a clock runs from the last
 * `touch()`, and `onIdle` fires once it lapses. The Map card's finder holds
 * the picture on a room the player picked; a hand still on the finder keeps
 * it, and a minute of none gives the picture back to the character. The
 * delay is read when the clock is armed, so an edit to the tuning takes on
 * the next touch, as every renderer clock does (`lib/tuning.ts`).
 *
 * `touch` changes identity only with `active`: the delay and the callback are
 * read through refs, so a card re-rendering on every status line (which the
 * Map card does) does not start the clock again.
 */
import { useCallback, useEffect, useRef } from 'react';

export function useIdleReset(
  active: boolean,
  delayMs: () => number,
  onIdle: () => void
): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ delayMs, onIdle });
  latest.current = { delayMs, onIdle };
  const touch = useCallback((): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (!active) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      latest.current.onIdle();
    }, latest.current.delayMs());
  }, [active]);
  // Becoming active arms the clock; going quiet, or unmounting, puts it down.
  useEffect(() => {
    touch();
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [touch]);
  return touch;
}
