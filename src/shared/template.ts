/**
 * The template grammar every console rewrite is authored in.
 *
 * A layout is text with `{tags}`: a figure the caller resolves, a colour by
 * palette name (`{red}`), by hex (`{#ff8800}`) or for the ground (`{bg:blue}`),
 * `{bold}`, `{dim}`, `{reset}`. Anything else, emoji included, is drawn as
 * typed. The status line was the first design written in it; the rewrites
 * (`rewrites.ts`) are the rest, and this is the one statement of the grammar
 * so a tag cannot mean one thing on the prompt row and another in a table.
 * `mudengine-ui` § The console is rewritten in one grammar.
 */
import type { InlineGlyph } from './types';

/** The sixteen colours a design may name, in the console's own palette. */
export const ANSI_COLOURS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const;
export type AnsiColour = (typeof ANSI_COLOURS)[number];

export function isAnsiColour(value: unknown): value is AnsiColour {
  return typeof value === 'string' && (ANSI_COLOURS as readonly string[]).includes(value);
}

/** A colour a figure wears from this fraction of its maximum up. */
export interface ColourBand {
  atLeast: number;
  colour: AnsiColour;
}

/** The band a figure sits in, highest floor first, or null while its maximum is unknown. */
export function bandFor(
  bands: readonly ColourBand[],
  value: number | null,
  max: number | null
): AnsiColour | null {
  if (value === null || max === null || max <= 0 || bands.length === 0) return null;
  const share = value / max;
  const sorted = [...bands].sort((a, b) => b.atLeast - a.atLeast);
  return sorted.find((band) => share >= band.atLeast)?.colour ?? null;
}

/** One run of a drawn line, with the attributes it wears. */
export interface Segment {
  text: string;
  /** A palette name, a `#rrggbb`, or null for the console's own ink. */
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
}

/**
 * A glyph drawn over the cells rather than typed into them: two cells of
 * the row are left blank and the renderer lays the picture over them, the
 * way it lays a shop's glyph beside a room's name. A glyph carrying commands
 * is a button; one without is a statement, and its label says what.
 */
export type Glyph = Omit<InlineGlyph, 'x'>;

/** A glyph placed on a drawn line, at the cell it starts in. */
export type PlacedGlyph = InlineGlyph;

/** Cells a glyph occupies in the row it is drawn over. */
export const GLYPH_CELLS = 2;

/**
 * What a figure tag resolves to: text, an optional colour of its own that
 * ends with the text, and an optional glyph drawn in the text's place.
 */
export interface Cell {
  text: string;
  colour?: string | null;
  glyph?: Glyph;
}

/** A figure tag's value, or null for a tag this template does not know. */
export type Resolve = (tag: string) => Cell | null;

const HEX = /^#[0-9a-f]{6}$/i;
const TAG = /\{([^{}]{1,40})\}/g;

/** What a glyph's cells hold in the text: blank, so the picture has room. */
export const GLYPH_BLANK = ' '.repeat(GLYPH_CELLS);

/**
 * Cells a string paints in a fixed grid: emoji and East Asian wide characters
 * take two, marks, joiners and variation selectors none. An approximation of
 * the terminal's own measurement, used to hold the prompt row under the
 * repaint's seventy-nine columns and to line a table's columns up.
 */
export function cellsOf(text: string): number {
  let cells = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x200d || code === 0xfe0f || /\p{M}/u.test(ch)) continue;
    if (/\p{Extended_Pictographic}/u.test(ch) && code > 0x2000) cells += 2;
    else if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      cells += 2;
    } else cells += 1;
  }
  return cells;
}

export interface Drawn {
  segments: Segment[];
  glyphs: PlacedGlyph[];
  cells: number;
}

/**
 * The line a layout draws, as runs with their attributes, the glyphs placed
 * on it, and the cells it takes. Null for a blank layout.
 *
 * A figure with a colour of its own wears it for its own characters only and
 * hands the layout's colour back afterwards. A tag the resolver does not
 * know, and a colour the palette does not name, are drawn as typed: a typo
 * shows itself rather than vanishing.
 */
export function renderTemplate(layout: string, resolve: Resolve): Drawn | null {
  if (layout.trim().length === 0) return null;

  const segments: Segment[] = [];
  const glyphs: PlacedGlyph[] = [];
  let fg: string | null = null;
  let bg: string | null = null;
  let bold = false;
  let dim = false;
  let cells = 0;
  const push = (text: string, colour: string | null = fg): void => {
    if (text.length === 0) return;
    cells += cellsOf(text);
    const last = segments[segments.length - 1];
    if (last && last.fg === colour && last.bg === bg && last.bold === bold && last.dim === dim) {
      last.text += text;
    } else segments.push({ text, fg: colour, bg, bold, dim });
  };

  let at = 0;
  for (const match of layout.matchAll(TAG)) {
    push(layout.slice(at, match.index));
    at = match.index + match[0].length;
    const tag = match[1]!;
    const cell = resolve(tag);
    if (cell !== null) {
      if (cell.glyph !== undefined) {
        glyphs.push({ ...cell.glyph, x: cells });
        push(GLYPH_BLANK);
      }
      push(cell.text, cell.colour ?? fg);
    } else if (tag === 'reset') {
      fg = null;
      bg = null;
      bold = false;
      dim = false;
    } else if (tag === 'bold') bold = true;
    else if (tag === 'dim') dim = true;
    else if (tag.startsWith('bg:')) {
      const colour = tag.slice(3);
      if (isAnsiColour(colour) || HEX.test(colour)) bg = colour;
      else push(match[0]);
    } else if (isAnsiColour(tag) || HEX.test(tag)) fg = tag;
    else push(match[0]);
  }
  push(layout.slice(at));

  return { segments, glyphs, cells };
}

/** The tags a layout names, in order, figures and attributes alike. */
export function tagsIn(layout: string): string[] {
  return [...layout.matchAll(TAG)].map((match) => match[1]!);
}

function sgrColour(colour: string, background: boolean): string {
  if (isAnsiColour(colour)) {
    const index = ANSI_COLOURS.indexOf(colour);
    const base = index < 8 ? (background ? 40 : 30) + index : (background ? 100 : 90) + index - 8;
    return String(base);
  }
  const r = Number.parseInt(colour.slice(1, 3), 16);
  const g = Number.parseInt(colour.slice(3, 5), 16);
  const b = Number.parseInt(colour.slice(5, 7), 16);
  return `${background ? 48 : 38};2;${r};${g};${b}`;
}

/**
 * The runs as bytes for the console: one SGR per run, a reset at the end so
 * whatever the server prints after the line starts clean. Palette names
 * become the sixteen SGR colours, so the drawn line follows whichever
 * palette the console wears; a hex is a truecolor SGR.
 */
export function toAnsi(segments: readonly Segment[]): string {
  let out = '';
  for (const segment of segments) {
    const codes = ['0'];
    if (segment.bold) codes.push('1');
    if (segment.dim) codes.push('2');
    if (segment.fg !== null) codes.push(sgrColour(segment.fg, false));
    if (segment.bg !== null) codes.push(sgrColour(segment.bg, true));
    out += `\x1b[${codes.join(';')}m${segment.text}`;
  }
  return `${out}\x1b[0m`;
}
