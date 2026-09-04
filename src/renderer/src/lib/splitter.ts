/**
 * The arithmetic behind a draggable pane edge, kept pure so the rules can be
 * tested without a DOM.
 *
 * Three rules, in the order they win:
 *
 * 1. **The console never drops under 80 measured columns.** docs/ui-design.md
 *    §1 and §3.8: the server formats to 80 and never negotiates NAWS, so a
 *    narrower console shears every map and stat column client-side. The floor
 *    is *measured* — the live terminal's cell width times 80 — never a pixel
 *    constant, for the same reasons `columnsIfSplit` gives.
 * 2. **A pane has a comfortable range of its own.** The card rail is unreadable
 *    under ~260px (the map's legend, an inventory row with its slot) and past
 *    ~560px it is spending width the console wants for nothing a card needs; the
 *    tab rail wants a name and a health figure and no more. Ranges, not
 *    points, so a player can tune within them.
 * 3. **When the window cannot honour both, the pane sits at its minimum and the
 *    console is *reported* narrow** — never rearranged under someone's hands,
 *    which §4 rejects. So a ceiling below the floor collapses onto the floor.
 *
 * Handle size follows WCAG 2.5.8 (24×24 CSS px minimum target): the visible
 * seam is a hairline, the hit area is 24px wide whatever the density's gap.
 */

export interface SplitRange {
  /** Narrowest the pane may be dragged, in CSS px. */
  min: number;
  /** Widest, before the console's floor is considered. */
  max: number;
}

/** The card rail beside the console. */
export const RAIL_RANGE: SplitRange = { min: 260, max: 560 };
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
 * The widest a pane may be, given how much slack the console has right now.
 *
 * `consoleWidth` is the terminal box as laid out; `cellWidth` is what one
 * column costs on this display at this font. Whatever the console holds beyond
 * eighty columns is the only width a pane may take, on top of what it has.
 */
export function ceilingFor(
  range: SplitRange,
  current: number,
  consoleWidth: number,
  cellWidth: number,
  keep = CONSOLE_COLUMNS
): SplitRange {
  if (!Number.isFinite(cellWidth) || cellWidth <= 0 || !Number.isFinite(consoleWidth)) {
    return range;
  }
  const slack = consoleWidth - cellWidth * keep;
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
