/**
 * What each splitter measures and the range it may be dragged within: the
 * pane's laid-out box, read when a gesture starts, and a ceiling that keeps
 * the console eighty measured columns and twelve measured rows. The card rail
 * has no splitter of its own; it is what the console leaves, and the first to
 * give width to a wider tab rail or a wider console. The console's handle
 * moves whole columns (todo 09).
 *
 * Out of `App` (todo 733); the arithmetic is `lib/splitter.ts`. See
 * `mudengine-ui` › `parts/cards.md`, *The edge between two panes is a
 * handle*.
 */
import { useCallback, type RefObject } from 'react';

import type { PaneWidths } from './usePaneWidths';
import { consoleGrid, consoleRoom } from '../lib/consoleWidth';
import {
  CONSOLE_RANGE,
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
 * @param across Panes side by side, each of which holds the columns chosen.
 */
export function usePaneRanges(
  layersRef: RefObject<HTMLElement>,
  size: TerminalSize,
  across: number,
  widths: Pick<PaneWidths, 'setColumns' | 'setTabs' | 'setAbove' | 'setBelow'>
) {
  const { setColumns, setTabs, setAbove, setBelow } = widths;
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
      const grid = consoleGrid();
      if (!box || grid === null) return TAB_RAIL_RANGE;
      return ceilingFor(TAB_RAIL_RANGE, current, consoleRoom(box), grid.cell);
    },
    [size.rows]
  );

  /*
   * What each splitter reads when a gesture or a key needs the pane's width,
   * and the range it is clamped to. Stable callbacks, because the splitters
   * are memoised and an arrow per render redrew all of them on every commit;
   * the measuring itself moved out of the render path with them — see
   * `Splitter`.
   */
  /*
   * The console's handle works in the px its columns take, every pane across
   * together, so a drag moves it under the pointer; what is kept is the
   * whole columns that is (`setConsole`). Its ceiling is what the card rail
   * holds beyond its one card column.
   */
  const measureConsole = useCallback((): number => {
    const grid = consoleGrid();
    return grid === null ? 0 : grid.cols * grid.cell * across;
  }, [across]);
  const rangeForConsole = useCallback((): SplitRange => {
    const box = layersRef.current;
    const grid = consoleGrid();
    if (!box || grid === null) return { min: 0, max: 0 };
    const per = grid.cell * across;
    const room = grid.cols * per + consoleRoom(box) - box.clientWidth;
    return {
      min: CONSOLE_RANGE.min * per,
      max: Math.min(CONSOLE_RANGE.max * per, Math.floor(room))
    };
  }, [across]);
  const setConsole = useCallback(
    (px: number) => {
      const grid = consoleGrid();
      if (grid !== null) setColumns(px / (grid.cell * across));
    },
    [across, setColumns]
  );
  const resetConsole = useCallback(() => setColumns(Number.NaN), [setColumns]);

  const rangeForTabs = useCallback(() => rangeFor('tabs'), [rangeFor]);
  const rangeForAbove = useCallback(() => rangeFor('above'), [rangeFor]);
  const rangeForBelow = useCallback(() => rangeFor('below'), [rangeFor]);
  const resetTabs = useCallback(() => setTabs(Number.NaN), [setTabs]);
  const resetAbove = useCallback(() => setAbove(Number.NaN), [setAbove]);
  const resetBelow = useCallback(() => setBelow(Number.NaN), [setBelow]);

  return {
    measureConsole,
    rangeForConsole,
    setConsole,
    resetConsole,
    rangeForTabs,
    rangeForAbove,
    rangeForBelow,
    resetTabs,
    resetAbove,
    resetBelow
  };
}
