/**
 * The lines a `{table}` may be drawn with: a frame around it and lines
 * between its cells (user, 2026-11-18).
 *
 * A line between columns is `│` in a cell of its own, where the template put
 * blank text between two figures. A line between rows takes no row: it is the
 * underline of the row above it, in the line's colour, so a ruled listing is
 * as tall as an unruled one plus the frame's top. `mudengine-ui` › *A table
 * may be ruled*.
 */

/**
 * The lines a table asked for, each kind by its colour: `frame` around the
 * table, `cells` between its columns and rows. Null is none of that kind,
 * and a table with neither has no `TableBorders`.
 */
export type TableBorders = {
  /** Blank cells each side of an upright line. */
  padding: number;
} & ({ frame: string; cells: string | null } | { frame: null; cells: string });

/** An upright line between two columns, down the middle of a cell of its own. */
const UPRIGHT = '│';

/**
 * The frame's two sides, each at the outer edge of its cell. A row's line is
 * an underline, which runs the whole width of a cell, so a side drawn down
 * the middle of one (`│`) left the line sticking out half a cell past it
 * (seen in the console, 2026-11-18).
 */
const FRAME_LEFT = '▏';
const FRAME_RIGHT = '▕';

/** What the pass asks of a row's pieces, so it need not know what a piece is. */
export interface Ruling<Piece> {
  /** Whether the piece is a figure the table lines up. */
  isColumn: (piece: Piece) => boolean;
  /** Whether the piece draws nothing but blank cells. */
  isBlank: (piece: Piece) => boolean;
  /** The cells the piece takes. */
  width: (piece: Piece) => number;
  /** Plain text of the table's own: blank cells, or an upright line in a colour. */
  plain: (text: string, colour: string | null) => Piece;
  /** The piece with a line under it. */
  under: (piece: Piece, colour: string) => Piece;
}

/**
 * The table's rows with its lines drawn in. `rows` are the aligned lines; one
 * that draws nothing before the first row or after the last is left alone,
 * since it is the line the table opens or closes on. `header` says the first
 * row drawn is the labels.
 */
export function ruleTable<Piece>(
  rows: readonly Piece[][],
  header: boolean,
  borders: TableBorders,
  ruling: Ruling<Piece>
): Piece[][] {
  const { frame, cells, padding } = borders;
  const widthOf = (row: readonly Piece[]): number =>
    row.reduce((sum, piece) => sum + ruling.width(piece), 0);
  const blank = (count: number): Piece[] =>
    count > 0 ? [ruling.plain(' '.repeat(count), null)] : [];
  const upright = (colour: string): Piece[] => [
    ...blank(padding),
    ruling.plain(UPRIGHT, colour),
    ...blank(padding)
  ];

  // The table is its first row that draws anything through its last; a blank
  // row between them is a row of it, and is framed like the rest.
  const drawn = rows.map((row) => widthOf(row) > 0);
  const firstDrawn = drawn.indexOf(true);
  const lastDrawn = drawn.lastIndexOf(true);
  const inTable = (at: number): boolean => firstDrawn >= 0 && at >= firstDrawn && at <= lastDrawn;
  const split = rows.map((row, at) =>
    inTable(at) && cells !== null ? splitCells(row, upright(cells), ruling) : row
  );
  const widest = Math.max(0, ...split.filter((_, at) => inTable(at)).map(widthOf));

  const out: Piece[][] = [];
  split.forEach((row, at) => {
    if (!inTable(at)) {
      out.push(row);
      return;
    }
    const filled = [...row, ...blank(widest - widthOf(row))];
    const inset = blank(padding);
    const full =
      frame === null
        ? filled
        : [
            ruling.plain(FRAME_LEFT, frame),
            ...inset,
            ...filled,
            ...inset,
            ruling.plain(FRAME_RIGHT, frame)
          ];
    const line = at === lastDrawn ? frame : header && at === firstDrawn ? (cells ?? frame) : cells;
    // The frame's top is the underline of a blank row above the first.
    if (at === firstDrawn && frame !== null) {
      out.push(blank(widthOf(full)).map((piece) => ruling.under(piece, frame)));
    }
    out.push(line === null ? full : full.map((piece) => ruling.under(piece, line)));
  });
  return out;
}

/**
 * A row with an upright line wherever blank text stands between two figures.
 * Figures with other text between them, or none, stay one cell, so the
 * template says where the lines go.
 */
function splitCells<Piece>(
  row: readonly Piece[],
  line: readonly Piece[],
  ruling: Ruling<Piece>
): Piece[] {
  const out: Piece[] = [];
  let between: Piece[] = [];
  let seen = false;
  for (const piece of row) {
    if (!ruling.isColumn(piece)) {
      between.push(piece);
      continue;
    }
    const gap = seen && between.length > 0 && between.every(ruling.isBlank);
    out.push(...(gap ? line : between), piece);
    between = [];
    seen = true;
  }
  return [...out, ...between];
}
