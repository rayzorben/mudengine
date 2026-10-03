/**
 * Runs `run` after the card this is drawn in changes size (`lib/cardSize.ts`),
 * once the commit that redrew it for the new size is laid out. For a face
 * whose scroll position depends on what that size draws: the Talk feed gains
 * or loses its stamp column, and its box alone does not say so.
 */
import { useLayoutEffect, useRef } from 'react';

import { useCardSize } from '../hooks/useCardSize';

export default function OnCardSize({ run }: { run(): void }): null {
  const size = useCardSize();
  const latest = useRef(run);
  useLayoutEffect(() => {
    latest.current = run;
  });
  const drawn = useRef(size);
  useLayoutEffect(() => {
    if (drawn.current === size) return;
    drawn.current = size;
    latest.current();
  }, [size]);
  return null;
}
