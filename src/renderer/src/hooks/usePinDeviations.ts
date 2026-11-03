import { useCallback, useState } from 'react';

import { isPinned, readDeviations, withPin, type PinDeviations } from '../lib/pins';
import { readStored, writeStored } from '../lib/storage';

/**
 * The player's pins against a shipped list, kept in `localStorage` under one
 * key: the palette's shelf and the toolbar's row each hold one. What a pin
 * means is `lib/pins.ts`; this is the state and the one place it is stored.
 *
 * @param key Where the deviations are stored.
 * @param shipped Whether the file pins an id now, read at the click.
 */
export function usePinDeviations(
  key: string,
  shipped: (id: string) => boolean
): [PinDeviations, (id: string) => void] {
  // An empty record leaves the shipped list in force.
  const [deviations, setDeviations] = useState<PinDeviations>(() =>
    readStored(key, readDeviations, () => ({}))
  );

  const toggle = useCallback(
    (id: string) => {
      setDeviations((current) => {
        // Recomputed here rather than closed over, so a config push landing
        // between the render and the click cannot make the click record what
        // the file no longer says.
        const file = shipped(id);
        const next = withPin(current, id, file, !isPinned(id, file, current));
        writeStored(key, JSON.stringify(next));
        return next;
      });
    },
    [key, shipped]
  );

  return [deviations, toggle];
}
