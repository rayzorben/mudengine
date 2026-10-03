/**
 * What each splitter measures and the range it may be dragged within: the
 * pane's laid-out box, read when a gesture starts, and a ceiling that keeps
 * the console eighty measured columns and twelve measured rows. The card rail
 * has no splitter; it is what the console leaves, and the first to give
 * width to a wider tab rail.
 *
 * Out of `App` (todo 733); the arithmetic is `lib/splitter.ts`. See
 * `mudengine-ui` › `parts/cards.md`, *The edge between two panes is a
 * handle*.
 */
import { useCallback, type RefObject } from 'react';

import type { PaneWidths } from './usePaneWidths';
import { consoleCellWidth, consoleRoom } from '../lib/consoleWidth';
import {
  CONSOLE_ROWS,
  DOCK_RANGE,
  TAB_RAIL_RANGE,
  ceilingFor,
  type SplitRange
} from '../lib/splitter';
import type { TerminalSize } from '@shared/types';

/*
 * A laid-out element's box, for the splitter arithmetic. Measured from the
 * DOM, never a constant — the same rule the column floor follows.
 */
function widthOf(selector: string, fallback: number): number {
  return document.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width ?? fallback;
}
function heightOf(selector: string, fallback: number): number {
  return document.querySelector<HTMLElement>(selector)?.getBoundingClientRect().height ?? fallback;
}
/*
 * What each splitter measures, as functions it calls when a gesture starts
 * rather than figures computed on every render of the window: a
 * `getBoundingClientRect` in a render is a forced layout, three panes' worth
 * per commit.
 */
export const measureTabs = (): number => widthOf('.workspace > .tab-rail', TAB_RAIL_RANGE.min);
export const measureAbove = (): number => heightOf('.dock-above > .card', DOCK_RANGE.min);
export const measureBelow = (): number => heightOf('.dock-below > .card', DOCK_RANGE.min);

/**
 * @param layersRef The console's box, which the panes divide.
 * @param size The shown console's measured size, in cells.
 */
export function usePaneRanges(
  layersRef: RefObject<HTMLElement>,
  size: TerminalSize,
  widths: Pick<PaneWidths, 'setTabs' | 'setAbove' | 'setBelow'>
) {
  const { setTabs, setAbove, setBelow } = widths;
  const rangeFor = useCallback(
    (which: 'tabs' | 'above' | 'below'): SplitRange => {
      const box = layersRef.current;
      if (which === 'above' || which === 'below') {
        // A strip takes rows from the console; it keeps its own floor of them.
        const current = heightOf(`.dock-${which} > .card`, DOCK_RANGE.min);
        if (!box || size.rows <= 0) return DOCK_RANGE;
        return ceilingFor(
          DOCK_RANGE,
          current,
          box.clientHeight,
          box.clientHeight / size.rows,
          CONSOLE_ROWS
        );
      }
      const current = widthOf('.workspace > .tab-rail', TAB_RAIL_RANGE.min);
      const cell = consoleCellWidth(size.cols);
      if (!box || cell === null) return TAB_RAIL_RANGE;
      return ceilingFor(TAB_RAIL_RANGE, current, consoleRoom(box), cell);
    },
    [size.cols, size.rows]
  );

  /*
   * What each splitter reads when a gesture or a key needs the pane's width,
   * and the range it is clamped to. Stable callbacks, because the splitters
   * are memoised and an arrow per render redrew all of them on every commit;
   * the measuring itself moved out of the render path with them — see
   * `Splitter`.
   */
  const rangeForTabs = useCallback(() => rangeFor('tabs'), [rangeFor]);
  const rangeForAbove = useCallback(() => rangeFor('above'), [rangeFor]);
  const rangeForBelow = useCallback(() => rangeFor('below'), [rangeFor]);
  const resetTabs = useCallback(() => setTabs(Number.NaN), [setTabs]);
  const resetAbove = useCallback(() => setAbove(Number.NaN), [setAbove]);
  const resetBelow = useCallback(() => setBelow(Number.NaN), [setBelow]);

  return {
    rangeForTabs,
    rangeForAbove,
    rangeForBelow,
    resetTabs,
    resetAbove,
    resetBelow
  };
}
