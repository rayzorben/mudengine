/**
 * The console holds a page of backscroll, not all of it.
 *
 * Main keeps `terminal.scrollback` lines; a console holds
 * `tuning.view.consolePageLines`, offers the next page back at its top, and
 * drops to one page again at the live edge. A tab attaching after a day of play
 * was sent every line main kept, and the web image closed it for the size
 * (2026-09-28). `mudengine-ui` › *A console holds a page of backscroll*.
 */

/** Where the reader is: the oldest line held, the live edge, or neither. */
export type ScrollEdge = 'top' | 'latest' | 'between';

/** The edge a viewport is at, from xterm's `viewportY` and `baseY`. */
export function edgeOf(viewportY: number, baseY: number): ScrollEdge {
  if (viewportY >= baseY) return 'latest';
  return viewportY === 0 ? 'top' : 'between';
}

/** How many lines a console holds after one more page, never past what main keeps. */
export function widened(hold: number, page: number, keep: number): number {
  return Math.min(hold + page, keep);
}

/** The lines a console holds at the live edge: one page, or all main keeps if less. */
export function onePage(page: number, keep: number): number {
  return Math.max(0, Math.min(page, keep));
}
