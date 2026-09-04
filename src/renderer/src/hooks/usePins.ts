import { useCallback, useMemo, useState } from 'react';

import {
  isPinned,
  readDeviations,
  resolvePins,
  shippedPins,
  withPin,
  type PinDeviations,
  type PinnableCommand
} from '../lib/pins';

/**
 * Per client, not per character, and not in a file.
 *
 * Which commands somebody keeps at the top of their palette is the same kind
 * of choice as the density and the theme — it belongs to the person at the
 * keyboard rather than to a character, and a preference changed by clicking
 * must not make the client rewrite a file full of the user's own comments.
 * `internal.yaml` still states the shelf everybody starts from; this is only
 * the deviation from it.
 */
const KEY = 'mudengine.palette.pins';

export interface PinnedCommands {
  /** The command ids currently on the shelf. */
  pinned: ReadonlySet<string>;
  /** Pin an unpinned command, or unpin a pinned one. */
  toggle(id: string): void;
}

export function usePinnedCommands(
  patterns: Record<string, string[]>,
  commands: readonly PinnableCommand[]
): PinnedCommands {
  const [deviations, setDeviations] = useState<PinDeviations>(() => {
    try {
      return readDeviations(window.localStorage.getItem(KEY));
    } catch {
      // Private mode, or storage disabled. The shipped shelf is the fallback.
      return {};
    }
  });

  const pinned = useMemo(
    () => resolvePins(patterns, commands, deviations),
    [patterns, commands, deviations]
  );

  const toggle = useCallback(
    (id: string) => {
      setDeviations((current) => {
        // Recomputed here rather than closed over, so a config push that lands
        // between the render and the click cannot make the click record what
        // the file no longer says.
        const shipped = shippedPins(patterns, commands).has(id);
        const next = withPin(current, id, shipped, !isPinned(id, shipped, current));
        try {
          window.localStorage.setItem(KEY, JSON.stringify(next));
        } catch {
          // The choice still applies for as long as the window is open.
        }
        return next;
      });
    },
    [patterns, commands]
  );

  return { pinned, toggle };
}
