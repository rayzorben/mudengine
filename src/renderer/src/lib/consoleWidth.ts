/**
 * The console's width as the window has laid it out, for the arithmetic in
 * `lib/splitter.ts`. Read when a gesture or a fit needs it, never in a render
 * (`mudengine-ui` › *Nothing measures the DOM during a render*).
 */

/**
 * The pane the keyboard is in, which holds the shown character's terminal:
 * the one whose columns the status rail and `useConsoleWidth` are handed.
 * Null before a terminal is laid out.
 */
export function focusedPane(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '.terminal-layer[data-shown="true"][data-focused="true"]'
  );
}

/**
 * The focused pane's terminal as laid out now: the columns it holds, read off
 * the terminal's own element (`TerminalView` marks it on every resize), and
 * what one costs on this display at this font. xterm sizes `.xterm-screen` to
 * exactly its columns times the cell, so the quotient has no padding or
 * scrollbar in it. Both from the DOM and never from React's copy of the
 * size, which is a fit behind while a drag or a split is under way. Null
 * before a terminal has been laid out.
 */
export function consoleGrid(): { cols: number; cell: number } | null {
  const pane = focusedPane();
  const cols = Number(pane?.querySelector<HTMLElement>('.xterm')?.dataset['cols']);
  const screen = pane?.querySelector<HTMLElement>('.xterm-screen');
  if (!(cols > 0) || !screen) return null;
  const cell = screen.getBoundingClientRect().width / cols;
  return Number.isFinite(cell) && cell > 0 ? { cols, cell } : null;
}

/**
 * The width the console could have: its own box and what the card rail's
 * track holds beyond the one card column an open rail keeps. Read off the
 * workspace's resolved tracks rather than the rail's box, because a closed
 * rail has no box and its empty `auto` track still holds that width. The
 * track order is the one `index.css` declares for `.workspace`.
 */
export function consoleRoom(box: HTMLElement): number {
  const workspace = document.querySelector<HTMLElement>('.workspace');
  if (!workspace) return box.clientWidth;
  const style = getComputedStyle(workspace);
  // Five tracks in every state; the rail's is the first when mirrored.
  const tracks = style.gridTemplateColumns.split(' ').map(parseFloat);
  const rail = workspace.dataset['railSide'] === 'left' ? tracks[0] : tracks[4];
  if (rail === undefined || !Number.isFinite(rail)) return box.clientWidth;
  const kept =
    workspace.dataset['rail'] === 'open'
      ? parseFloat(style.getPropertyValue('--rail-column-min')) || 0
      : 0;
  return box.clientWidth + Math.max(0, rail - kept);
}
