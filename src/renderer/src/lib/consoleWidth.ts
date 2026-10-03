/**
 * The console's width as the window has laid it out, for the arithmetic in
 * `lib/splitter.ts`. Read when a gesture or a fit needs it, never in a render
 * (`mudengine-ui` › *Nothing measures the DOM during a render*).
 */

/**
 * What one column costs on this display at this font, off the shown
 * terminal: xterm sizes `.xterm-screen` to exactly its columns times the
 * cell, so the quotient has no padding or scrollbar in it. Null before a
 * terminal has been laid out.
 */
export function consoleCellWidth(cols: number): number | null {
  if (!(cols > 0)) return null;
  const screen = document.querySelector<HTMLElement>(
    '.terminal-layer[data-shown="true"] .xterm-screen'
  );
  const cell = (screen?.getBoundingClientRect().width ?? 0) / cols;
  return Number.isFinite(cell) && cell > 0 ? cell : null;
}

/**
 * The width the console could have: its own box and the card rail's track
 * beside it, which takes only what the console leaves and gives all of it
 * back first. Read off the workspace's resolved tracks rather than the rail's
 * box, because a closed rail has no box and its empty `auto` track still holds
 * that width.
 */
export function consoleRoom(box: HTMLElement): number {
  const workspace = document.querySelector<HTMLElement>('.workspace');
  if (!workspace) return box.clientWidth;
  // Five tracks in every state; the rail's is the first when mirrored.
  const tracks = getComputedStyle(workspace).gridTemplateColumns.split(' ').map(parseFloat);
  const rail = workspace.dataset['railSide'] === 'left' ? tracks[0] : tracks[4];
  return box.clientWidth + (rail !== undefined && Number.isFinite(rail) ? rail : 0);
}
