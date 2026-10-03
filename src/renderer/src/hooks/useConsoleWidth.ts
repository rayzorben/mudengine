/**
 * The console's track, held at the columns the player chose, eighty to a
 * hundred and twenty a pane across (todo 09, 2026-10-03). The card rail
 * takes what is left of the window.
 *
 * Measured after each fit and after each change in panes across: the track,
 * the focused pane and the shown terminal's cell give the width that holds
 * `keep` (`consoleTrack`), written to the workspace as `--console-w`. Until a
 * terminal has been measured the console shares the window with the rail.
 * See `mudengine-ui` › `parts/cards.md`, *The console is eighty to a hundred
 * and twenty columns wide*.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import { consoleGrid, focusedPane } from '../lib/consoleWidth';
import { CONSOLE_COLUMNS, consoleTrack } from '../lib/splitter';

/**
 * @param cols The shown console's fitted columns, which runs this again after each fit.
 * @param across Panes side by side: each one holds `keep`.
 * @param keep The columns the player chose; null is eighty.
 * @returns The workspace's custom property, empty before anything is measured.
 */
export function useConsoleWidth(
  cols: number,
  across: number,
  keep: number | null
): Record<string, string> {
  const [track, setTrack] = useState<number | null>(null);
  /*
   * What a pane holds besides its columns, from the last run in which the
   * terminal's fit matched the panes as laid out. A change in panes across
   * lays the panes out before any terminal fits, so in that run the pane's
   * width is new and its columns are not: the overhead from the run before
   * is the one that is true. Using it is what answers a split in the frame
   * it lands, instead of after the terminals have fitted at half the width
   * and told the server so (the flake in the smoke's side-by-side check).
   */
  const overhead = useRef<number | null>(null);
  const laidAcross = useRef(across);

  /*
   * A layout effect, so the corrected track is painted in the frame the fit
   * or the split landed in rather than one frame later at the wrong width.
   */
  useLayoutEffect(() => {
    const stack = document.querySelector<HTMLElement>('.workspace > .terminal-stack');
    const pane = focusedPane();
    const grid = consoleGrid();
    if (!stack || !pane || grid === null) return;
    const { cell } = grid;
    const width = pane.getBoundingClientRect().width;
    const fitMatches = laidAcross.current === across;
    laidAcross.current = across;
    if (fitMatches || overhead.current === null) overhead.current = width - grid.cols * cell;
    const next = consoleTrack(
      stack.getBoundingClientRect().width,
      width,
      overhead.current,
      cell,
      across,
      keep ?? CONSOLE_COLUMNS
    );
    if (next !== null) setTrack(next);
  }, [cols, across, keep]);

  return useMemo((): Record<string, string> => {
    if (track === null) return {};
    return { '--console-w': `${track}px` };
  }, [track]);
}
