/**
 * Where the reader is, carried from the live console into the copy of the backscroll
 * (todo 120). Pure: rows in, rows out. Every off by one of the hand-over is
 * here, so the components only read rows and scroll.
 *
 * A row is what xterm draws; a line is what the game printed, one or more rows
 * when it is wider than the console. The reader's place is a line counted
 * from the end, with its text and the next few lines' to tell it from a line
 * that repeats (a fight prints the same swing twenty times). The copy is read
 * from main after the place was taken, so lines that arrived meanwhile put the
 * place further from the end in the copy, never nearer.
 */
import { tuning } from './tuning';

/** One row of a console's buffer. `wrapped` is a row continuing the one above. */
export interface Row {
  text: string;
  wrapped: boolean;
}

/** One printed line, and the first row it is drawn on. */
export interface Line {
  text: string;
  row: number;
}

/** The reader's place: the line at the top of the view, counted from the last line. */
export interface Place {
  fromEnd: number;
  /** That line's text and the ones after it, as many as there are up to `span`. */
  texts: string[];
}

/** As much of an xterm buffer as reading its rows needs. */
export interface RowSource {
  readonly length: number;
  getLine(
    row: number
  ): { readonly isWrapped: boolean; translateToString(trim: boolean): string } | undefined;
}

/** A buffer's rows, top to bottom, each trimmed at the right as xterm copies it. */
export function rowsOf(buffer: RowSource): Row[] {
  const rows: Row[] = [];
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (line !== undefined)
      rows.push({ text: line.translateToString(true), wrapped: line.isWrapped });
  }
  return rows;
}

/** Rows joined into the lines they draw. A first row marked wrapped starts a line. */
export function linesOf(rows: readonly Row[]): Line[] {
  const lines: Line[] = [];
  rows.forEach((row, index) => {
    const last = lines[lines.length - 1];
    if (row.wrapped && last !== undefined) last.text += row.text;
    else lines.push({ text: row.text, row: index });
  });
  return lines;
}

/** The line drawn on `row`: the last line starting at or above it. */
function lineAt(lines: readonly Line[], row: number): number {
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lines[middle]!.row <= row) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The place of the line drawn on `row`, or null with nothing drawn. */
export function placeAt(
  lines: readonly Line[],
  row: number,
  span = tuning().readBackSpan
): Place | null {
  if (lines.length === 0) return null;
  const index = lineAt(lines, Math.max(0, row));
  return {
    fromEnd: lines.length - 1 - index,
    texts: lines.slice(index, index + span).map((line) => line.text)
  };
}

/**
 * The row to put at the top of the copy's view to show `place`, or null when
 * its lines are not there within `reach` lines of where they should be.
 * Nearest first; at an equal distance, the older one, since lines arrive
 * between the place being taken and the copy being read.
 */
export function rowOf(lines: readonly Line[], place: Place, reach: number): number | null {
  const expected = lines.length - 1 - place.fromEnd;
  const matches = (index: number): boolean =>
    index >= 0 &&
    index < lines.length &&
    place.texts.every((text, offset) => lines[index + offset]?.text === text);
  for (let distance = 0; distance <= reach; distance += 1) {
    if (matches(expected - distance)) return lines[expected - distance]!.row;
    if (distance > 0 && matches(expected + distance)) return lines[expected + distance]!.row;
  }
  return null;
}
