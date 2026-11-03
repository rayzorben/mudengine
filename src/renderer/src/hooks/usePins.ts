import { useCallback, useMemo } from 'react';

import { usePinDeviations } from './usePinDeviations';
import { resolvePins, shippedPins, type PinnableCommand } from '../lib/pins';

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
  const shipped = useCallback(
    (id: string) => shippedPins(patterns, commands).has(id),
    [patterns, commands]
  );
  const [deviations, toggle] = usePinDeviations(KEY, shipped);

  const pinned = useMemo(
    () => resolvePins(patterns, commands, deviations),
    [patterns, commands, deviations]
  );

  return { pinned, toggle };
}
