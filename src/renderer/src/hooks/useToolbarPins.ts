import { useCallback, useMemo, useState } from 'react';

import { pinnedMatches } from '@shared/internal';

import { readDeviations, isPinned, withPin, type PinDeviations } from '../lib/pins';

/**
 * Which toolbar buttons are drawn, and which live behind the kebab.
 *
 * The palette's shelf rule, applied to a row of glyphs: `internal.yaml` states
 * what a fresh client draws, a click on the kebab's row moves a button on or
 * off, and the deviation is stored **against what the file said at the time**
 * so an edit to the file is not silently ignored for ever after the first
 * click. `lib/pins.ts` is that decision and is shared rather than copied —
 * two implementations of it would eventually disagree about what an edit
 * means.
 *
 * The one difference from the palette is the shape of the shipped list: a
 * palette command belongs to a group and is matched per group, and a toolbar
 * button belongs to no group because the row *is* the group. So the patterns
 * are one flat list.
 *
 * Per client, not per character, and not in a file — which side of that line
 * this falls on is decided by whether it describes the player or the moment,
 * and which buttons somebody keeps to hand is the player. What the buttons
 * *say* is per character, and comes from that character's own YAML.
 */
const KEY = 'mudengine.toolbar.pins';

export interface PinnedToolbar {
  /** The button ids currently on the row, as a set. */
  pinned: ReadonlySet<string>;
  toggle(id: string): void;
}

/** The row as the file states it. */
export function shippedToolbar(patterns: readonly string[], ids: readonly string[]): Set<string> {
  const kept = new Set<string>();
  for (const id of ids) {
    if (patterns.some((pattern) => pinnedMatches(pattern, id))) kept.add(id);
  }
  return kept;
}

export function useToolbarPins(patterns: readonly string[], ids: readonly string[]): PinnedToolbar {
  const [deviations, setDeviations] = useState<PinDeviations>(() => {
    try {
      return readDeviations(window.localStorage.getItem(KEY));
    } catch {
      // Private mode, or storage disabled. The shipped row is the fallback.
      return {};
    }
  });

  const pinned = useMemo(() => {
    const shipped = shippedToolbar(patterns, ids);
    const kept = new Set<string>();
    for (const id of ids) {
      if (isPinned(id, shipped.has(id), deviations)) kept.add(id);
    }
    return kept;
  }, [patterns, ids, deviations]);

  const toggle = useCallback(
    (id: string) => {
      setDeviations((current) => {
        // Recomputed here rather than closed over, so a config push landing
        // between the render and the click cannot make the click record what
        // the file no longer says.
        const shipped = shippedToolbar(patterns, ids).has(id);
        const next = withPin(current, id, shipped, !isPinned(id, shipped, current));
        try {
          window.localStorage.setItem(KEY, JSON.stringify(next));
        } catch {
          // The choice still applies for as long as the window is open.
        }
        return next;
      });
    },
    [patterns, ids]
  );

  return { pinned, toggle };
}
