import { useCallback, useMemo, useState } from 'react';

import { DOCK_RANGE, RAIL_RANGE, TAB_RAIL_RANGE, rememberedWidth } from '../lib/splitter';

/**
 * How wide the player dragged the rails, remembered per client.
 *
 * Per client rather than per character, like density and theme: a pane's
 * width is a fact about this window on this display, not about who is being
 * played, and a rail that jumped between widths on every tab switch would move
 * every control on it under the pointer. `localStorage`, for the same reason
 * the card layout uses it — a preference changed by dragging must not make the
 * client rewrite a file full of the user's own comments.
 *
 * A stored width is clamped on the way in (`rememberedWidth`), so a value from
 * an older build or a larger display can always be dragged back. `null` means
 * "the density's default", which is the token in `tokens.css`.
 */
export interface PaneWidths {
  rail: number | null;
  tabs: number | null;
  /** Heights of the strips docked above and below the console. */
  above: number | null;
  below: number | null;
  setRail(px: number): void;
  setTabs(px: number): void;
  setAbove(px: number): void;
  setBelow(px: number): void;
  reset(): void;
  /** CSS custom properties for the workspace; absent entries fall through to the tokens. */
  style: Record<string, string>;
}

const KEY = 'mudengine.layout.widths';

type Stored = {
  rail: number | null;
  tabs: number | null;
  above: number | null;
  below: number | null;
};
const NONE: Stored = { rail: null, tabs: null, above: null, below: null };

function read(): Stored {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return NONE;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return NONE;
    const record = parsed as Record<string, unknown>;
    return {
      rail: rememberedWidth(record['rail'], RAIL_RANGE),
      tabs: rememberedWidth(record['tabs'], TAB_RAIL_RANGE),
      above: rememberedWidth(record['above'], DOCK_RANGE),
      below: rememberedWidth(record['below'], DOCK_RANGE)
    };
  } catch {
    return NONE;
  }
}

function write(value: Stored): void {
  try {
    if (Object.values(value).every((entry) => entry === null)) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* storage refused; the width still applies for this session */
  }
}

export function usePaneWidths(): PaneWidths {
  const [widths, setWidths] = useState(read);

  const update = useCallback((next: Stored) => {
    write(next);
    setWidths(next);
  }, []);

  const setRail = useCallback(
    (px: number) => update({ ...widths, rail: rememberedWidth(px, RAIL_RANGE) }),
    [update, widths]
  );
  const setTabs = useCallback(
    (px: number) => update({ ...widths, tabs: rememberedWidth(px, TAB_RAIL_RANGE) }),
    [update, widths]
  );
  const setAbove = useCallback(
    (px: number) => update({ ...widths, above: rememberedWidth(px, DOCK_RANGE) }),
    [update, widths]
  );
  const setBelow = useCallback(
    (px: number) => update({ ...widths, below: rememberedWidth(px, DOCK_RANGE) }),
    [update, widths]
  );
  const reset = useCallback(() => update(NONE), [update]);

  const style = useMemo(() => {
    const out: Record<string, string> = {};
    if (widths.rail !== null) out['--rail-w'] = `${widths.rail}px`;
    if (widths.tabs !== null) out['--tab-rail-w'] = `${widths.tabs}px`;
    if (widths.above !== null) out['--dock-above-h'] = `${widths.above}px`;
    if (widths.below !== null) out['--dock-below-h'] = `${widths.below}px`;
    return out;
  }, [widths]);

  return { ...widths, setRail, setTabs, setAbove, setBelow, reset, style };
}
