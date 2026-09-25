/**
 * Whether the shown character's Navigation card is worth the space it takes:
 * a walk or a lap under way, a walk finished recently enough to be news, or
 * loops of its own to start.
 *
 * Out of `App` (todo 733). See `mudengine-ui` › `parts/cards.md`, *Routing,
 * looping or stopped: one card, one face, one transport*.
 */
import { useEffect, useState } from 'react';

import type { LoopProgress } from '@shared/loops';
import type { WalkProgress } from '@shared/walk';

/**
 * @param clearAfter `automation.walk.clearAfterSeconds`; 0 keeps a finished walk.
 * @param loopCount How many loops the character has to start.
 */
export function useNavigationVisible(
  walk: WalkProgress,
  loop: Pick<LoopProgress, 'status'>,
  inGame: boolean,
  loopCount: number,
  clearAfter: number
): boolean {
  /**
   * Whether the Navigation card is still worth the space it takes.
   *
   * A walk or a loop in progress always is. A *finished* walk is news for a
   * moment and clutter after it — and the card sits above the rest of the
   * rail, so it moves everything below it for as long as it stays.
   * `clearAfterSeconds: 0` keeps it, for anyone who would rather dismiss it
   * themselves.
   */
  const [walkStale, setWalkStale] = useState(false);
  const finished = walk.status === 'arrived' || walk.status === 'stopped';

  useEffect(() => {
    setWalkStale(false);
    if (!finished || clearAfter <= 0) return;
    // Keyed on the outcome as well as the status, so a second walk that ends
    // the same way still gets its own moment on screen.
    const timer = window.setTimeout(() => setWalkStale(true), clearAfter * 1000);
    return () => window.clearTimeout(timer);
  }, [finished, clearAfter, walk.reason, walk.destination, walk.done]);

  /*
   * Either half is reason enough, because they are one card.
   *
   * The walk half fades once it has been finished for `clearAfterSeconds`. The
   * loop half is a set of *controls*, so it shows while there is something to
   * control: a loop running, paused or just stopped, or a character in the
   * realm with loops of its own to start. With neither half the card is chrome,
   * and null.
   *
   * One test rather than two, because two would let the card appear for one
   * face and disappear for the other — which on a rail is every control below
   * it moving while somebody reaches for one.
   */
  return (
    (walk.status !== 'idle' && !walkStale) || loop.status !== 'idle' || (inGame && loopCount > 0)
  );
}
