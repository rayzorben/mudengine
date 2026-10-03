/**
 * The console's track, held at exactly eighty columns per pane across it
 * (todo 00, 2026-10-03). The card rail takes what is left of the window.
 *
 * Measured after each fit: the track as laid out and the shown terminal's
 * cell give the width that holds eighty (`consoleTrack`), written to the
 * workspace as `--console-w`. Until a terminal has been measured the console
 * shares the window with the rail. See `mudengine-ui` › `parts/cards.md`,
 * *The console is eighty columns wide*.
 */
import { useLayoutEffect, useMemo, useState } from 'react';

import { consoleCellWidth } from '../lib/consoleWidth';
import { consoleTrack } from '../lib/splitter';

/**
 * @param cols The shown console's fitted columns.
 * @param across Panes side by side: each one is eighty columns.
 * @returns The workspace's custom property, empty before anything is measured.
 */
export function useConsoleWidth(cols: number, across: number): Record<string, string> {
  const [track, setTrack] = useState<number | null>(null);

  /*
   * A layout effect, so the corrected track is painted in the frame the fit
   * landed in rather than one frame later at the wrong width. Each fit
   * reports a new size and runs this again; the answer is a fixed point, so
   * the second run with eighty columns asks for the width already set.
   */
  useLayoutEffect(() => {
    const stack = document.querySelector<HTMLElement>('.workspace > .terminal-stack');
    const cell = consoleCellWidth(cols);
    if (!stack || cell === null) return;
    const next = consoleTrack(stack.getBoundingClientRect().width, cols, cell, across);
    if (next !== null) setTrack(next);
  }, [cols, across]);

  return useMemo((): Record<string, string> => {
    if (track === null) return {};
    return { '--console-w': `${track}px` };
  }, [track]);
}
