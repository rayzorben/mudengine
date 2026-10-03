/**
 * The arithmetic behind a draggable pane edge and the console's width, kept
 * pure so the rules can be tested without a DOM.
 *
 * The console is a whole number of measured columns, eighty to a hundred and
 * twenty at the player's choice (todo 09, 2026-10-03): the server formats to
 * 80 and never negotiates NAWS, so a narrower console shears every map and
 * stat column. The card rail takes what is left of the window. When the
 * window cannot honour eighty the console is reported narrow rather than
 * rearranged. See `mudengine-ui` › `parts/cards.md`, *The console is eighty
 * to a hundred and twenty columns wide*.
 *
 * Handle size follows WCAG 2.5.8 (24×24 CSS px minimum target).
 */

/** How the panes divide the slate: stacked, or side by side. */
export type PaneFlow = 'rows' | 'columns';

export interface SplitRange {
  /** Narrowest the pane may be dragged, in CSS px. */
  min: number;
  /** Widest, before the console's floor is considered. */
  max: number;
}

/** The tab rail on the left edge. */
export const TAB_RAIL_RANGE: SplitRange = { min: 140, max: 320 };
/**
 * A strip docked above or below the console. Under ~120px a card shows its
 * heading and one row; past ~480px it is a second console's worth of height
 * spent on a card. The console keeps `CONSOLE_ROWS` measured rows the same way
 * it keeps its columns.
 */
export const DOCK_RANGE: SplitRange = { min: 120, max: 480 };
/** Rows the console must keep when a dock takes height from it. */
export const CONSOLE_ROWS = 12;
/**
 * How many columns the console must keep — under this it stops being a
 * character grid. Measured on two server implementations, neither of which
 * negotiates NAWS: output arrives at the width it arrives at whatever the
 * client reports, so a narrower pane wraps it client-side and shears every map
 * and stat column. The floor's one declaration; App imports it as
 * `MIN_COLUMNS`.
 */
export const CONSOLE_COLUMNS = 80;
/**
 * The columns the console's handle moves between: the eighty the game
 * formats to, and up to half again for a player who wants the room for a
 * long line or a wide window's worth of backscroll.
 */
export const CONSOLE_RANGE = { min: CONSOLE_COLUMNS, max: 120 } as const;
/** One arrow-key press, and one with Shift held. */
export const KEY_STEP = 16;
export const KEY_STEP_LARGE = 64;

/** Clamps into a range whose ceiling may have collapsed onto its floor. */
export function clampWidth(value: number, range: SplitRange): number {
  const max = Math.max(range.min, range.max);
  if (!Number.isFinite(value)) return range.min;
  return Math.min(max, Math.max(range.min, Math.round(value)));
}

/**
 * How wide the console's track must be for each pane across it to hold
 * exactly `keep` columns, or null before anything has been measured.
 *
 * `track` and `pane` are the track and one pane as laid out now, `overhead`
 * what a pane holds besides its columns (padding, the scrollbar and the part
 * of a column the last fit could not use), and `cell` what one column costs.
 * None of that changes with the track, so the answer is a fixed point: the
 * track it gives fits `keep` columns, and measured again it gives itself.
 * Because `pane` is read after the panes are laid out and not off the last
 * fit, a change in how many panes stand across is answered before the
 * terminals fit, rather than after a fit at the wrong width. Rounded up,
 * because a track a fraction short fits one column fewer.
 */
export function consoleTrack(
  track: number,
  pane: number,
  overhead: number,
  cell: number,
  across: number,
  keep = CONSOLE_COLUMNS
): number | null {
  if (![track, pane, cell, across].every((n) => Number.isFinite(n) && n > 0)) return null;
  if (!Number.isFinite(overhead) || overhead < 0) return null;
  return Math.ceil(track + (overhead + keep * cell - pane) * across);
}

/** A remembered console width in columns, held to `CONSOLE_RANGE`; null for anything else. */
export function rememberedColumns(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.min(CONSOLE_RANGE.max, Math.max(CONSOLE_RANGE.min, Math.round(raw)));
}

/**
 * The widest a pane may be, given how much slack the console has right now.
 *
 * `room` is the width the console could have: its own box plus whatever
 * yields to it first (the card rail, beside a fixed console). `cellWidth` is
 * what one column costs on this display at this font. Whatever that holds
 * beyond eighty columns is the only width a pane may take, on top of what it
 * has.
 */
export function ceilingFor(
  range: SplitRange,
  current: number,
  room: number,
  cellWidth: number,
  keep = CONSOLE_COLUMNS
): SplitRange {
  if (!Number.isFinite(cellWidth) || cellWidth <= 0 || !Number.isFinite(room)) {
    return range;
  }
  const slack = room - cellWidth * keep;
  const ceiling = Math.floor(current + slack);
  return { min: range.min, max: Math.min(range.max, ceiling) };
}

/**
 * What a key does to a pane's width, or null for a key this ignores.
 *
 * The WAI-ARIA window-splitter pattern: arrows move, Home and End go to the
 * ends, Shift makes a bigger step. `grows` is the arrow that makes *this* pane
 * wider — right for a pane on the left edge, left for one on the right.
 */
export type GrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';
const OPPOSITE: Record<GrowKey, GrowKey> = {
  ArrowLeft: 'ArrowRight',
  ArrowRight: 'ArrowLeft',
  ArrowUp: 'ArrowDown',
  ArrowDown: 'ArrowUp'
};

export function keyAdjust(
  key: string,
  shift: boolean,
  grows: GrowKey
): number | 'min' | 'max' | null {
  const step = shift ? KEY_STEP_LARGE : KEY_STEP;
  const shrinks = OPPOSITE[grows];
  if (key === grows) return step;
  if (key === shrinks) return -step;
  if (key === 'Home') return 'min';
  if (key === 'End') return 'max';
  return null;
}

/** Reads a remembered width back, refusing anything that is not a sane number. */
export function rememberedWidth(raw: unknown, range: SplitRange): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  // Out of range is not honoured as-is: a value from an older build or another
  // display is clamped on the way in, so it can always be dragged back.
  return clampWidth(raw, range);
}
