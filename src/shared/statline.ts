/**
 * The status line the client asks for, and how to read the one the realm says
 * it has.
 *
 * `set statline full custom <template>` renders a template of wildcards on
 * every prompt from then on, on GreaterMUD and MajorMUD alike (read off the
 * player's own transcripts of both, typed by hand on 2026-09-09; no probe
 * dials MajorMUD). The client composes the template — which figures it needs is a
 * fact, not a preference — and reads whatever `pro` reports the line to be, its
 * own or another client's, through a matcher generated from that report. The
 * tolerant `STATUS_LINE` pattern stays the fallback for `full` and for a
 * template this cannot build from. `mudengine-wire` § The status line is a
 * template, and the matcher is built from what `pro` reports.
 */
import type { CharacterState } from './character';

/** The figures a prompt can carry, as the realm's wildcards render them. */
export interface StatlineReading {
  hp: number | null;
  hpMax: number | null;
  mana: number | null;
  manaMax: number | null;
  exp: number | null;
  need: number | null;
  /** Cash on hand, in copper. */
  wealth: number | null;
  state: 'resting' | 'meditating' | null;
}

/**
 * The template the client sends: every figure something here reads, and
 * nothing else.
 *
 * `Wealth=` rather than `$=`, because `Wealth=` is the label the tolerant
 * reader already knows; `%r` last so the rest marker lands where the tolerant
 * pattern expects it; `%w` (warn on evil) dropped because nothing reads it.
 */
export const STATLINE_TEMPLATE = '[HP=%h/%H,MA=%m/%M,Exp=%x,Need=%X,Wealth=%c%r]:';

/**
 * The command that sets it. `full custom`, not `custom`: on the running
 * builds of both families the short form answered `Done.` and changed nothing
 * (2026-09-09), though the on-disk `SetCommand.cs` stores both the same way —
 * the wire outranks the source snapshot, which is older than the servers.
 */
export const SET_STATLINE = `set statline full custom ${STATLINE_TEMPLATE}`;

/** What `pro` reports for the class-default line. */
export const FULL_STATLINE = 'full';

export function isFullStatline(reported: string): boolean {
  return reported.trim().toLowerCase() === FULL_STATLINE;
}

/**
 * What each wildcard renders as, in plain text.
 *
 * `%h` arrives wrapped in a colour and a reset, which the plain text has
 * already lost. `%r` is ` (Resting) ` or ` (Meditating) ` when either is true,
 * and otherwise one space on GreaterMUD and nothing on MajorMUD — both are
 * admitted. Health may be negative on the way down; nothing else has been
 * seen with a sign, and `%X` is a subtraction the realm does not clamp.
 */
const WILDCARD: Readonly<Record<string, string>> = {
  h: '(?<hp>-?\\d{1,6})',
  H: '(?<hpMax>\\d{1,6})',
  m: '(?<mana>\\d{1,6})',
  M: '(?<manaMax>\\d{1,6})',
  x: '(?<exp>\\d{1,12})',
  X: '(?<need>-?\\d{1,12})',
  c: '(?<wealth>\\d{1,12})',
  w: '(?:On|Off)',
  r: '(?:\\s?\\((?<state>Resting|Meditating)\\)\\s?|\\s?)'
};

/**
 * `%f0`–`%f7` paint a colour and take no cells; the plain text has nothing to
 * match. Seen rendering on the live GreaterMUD build (2026-09-09); absent from
 * the on-disk `BuildCustomStatline()`, which is older than the server.
 */
const COLOUR_WILDCARD = /^%f[0-7]/;

/**
 * What the server splices in before the closing `]:` while the character is
 * invisible — `Showprompt` does `sb.Replace("]:", " (Invisible) ]:")` after
 * building the line (`Player.cs`; source, not yet a capture, 2026-09-09).
 * Admitted as optional wherever the template closes with `]:`, so going
 * invisible is not read as the line having been changed under the client.
 */
const INVISIBLE = '(?: \\(Invisible\\) )?';

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\/]/g;

/**
 * An exact matcher for a template, or null where none can be built.
 *
 * Null for `full` (the class-default line, whose rendering depends on the
 * class and on whether the character has mana), for `%n` (a second row, which
 * a line-framed reader cannot match), for a wildcard this client has not seen
 * render, and for a figure asked for twice. Every one of those is read by the
 * tolerant pattern instead, and the caller says so.
 *
 * Anchored at the start only: the server echoes the command it is answering
 * after the prompt, and a tail may be glued to it.
 */
export function statlineMatcher(template: string): RegExp | null {
  const text = template.trim();
  if (text.length === 0 || isFullStatline(text)) return null;
  let source = '^';
  const named = new Set<string>();
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch !== '%') {
      if (ch === ']' && text[i + 1] === ':') source += INVISIBLE;
      source += ch.replace(REGEX_SPECIAL, '\\$&');
      continue;
    }
    if (COLOUR_WILDCARD.test(text.slice(i))) {
      i += 2;
      continue;
    }
    const key = text[i + 1];
    const piece = key === undefined ? undefined : WILDCARD[key];
    if (key === undefined || piece === undefined) return null;
    if (piece.startsWith('(?<')) {
      if (named.has(key)) return null;
      named.add(key);
    }
    source += piece;
    i += 1;
  }
  if (named.size === 0) return null;
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

function figure(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** The figures off a prompt, by the matcher its template built; null when it does not match. */
export function readStatline(matcher: RegExp, plain: string): StatlineReading | null {
  const match = matcher.exec(plain);
  return match ? readingOf(match.groups ?? {}) : null;
}

/** The figures off a matcher's own groups, for a caller that already ran it. */
export function readingOf(g: Record<string, string | undefined>): StatlineReading {
  const state = g['state'];
  return {
    hp: figure(g['hp']),
    hpMax: figure(g['hpMax']),
    mana: figure(g['mana']),
    manaMax: figure(g['manaMax']),
    exp: figure(g['exp']),
    need: figure(g['need']),
    wealth: figure(g['wealth']),
    state: state === 'Resting' ? 'resting' : state === 'Meditating' ? 'meditating' : null
  };
}

/*
 * ───────────────────────────── the line the player designs ─────────────────
 *
 * The client intercepts the prompt, reads the real figures out of it, and
 * draws its own status line in their place — rendered at write time, never as
 * a transform over the buffer, so scrollback keeps whatever was drawn then.
 * The player designs the presentation; the content is the template above,
 * which is a fact. `mudengine-ui` § The status line the player designs is
 * drawn at write time, in the prompt row.
 */

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

/**
 * What the player authored. `layout` is text with `{tags}`: a figure
 * (`{hp}`, `{hpMax}`, `{mana}`, `{manaMax}`, `{exp}`, `{need}`, `{wealth}`,
 * `{state}`, `{level}`, `{room}`, `{lives}`, `{expSession}`), a colour by
 * name (`{red}`), by hex (`{#ff8800}`) or for the background (`{bg:blue}`),
 * `{bold}`, `{dim}`, `{reset}`. Anything else is drawn as typed, emoji
 * included. `bands` colour `{hp}` and `{mana}` by their fraction of maximum.
 */
export interface StatlineDesign {
  enabled: boolean;
  layout: string;
  bands: { hp: ColourBand[]; mana: ColourBand[] };
}

/** Everything a design may draw: the prompt's figures and what the client tracks beside them. */
export interface StatlineFigures extends StatlineReading {
  level: number | null;
  room: string | null;
  lives: number | null;
  expSession: number | null;
}

/** One run of the drawn line, with the attributes it wears. */
export interface StatlineSegment {
  text: string;
  /** A palette name, a `#rrggbb`, or null for the console's own ink. */
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
}

/**
 * The widest a drawn line may be, in cells.
 *
 * The server repaints the prompt in place with `ESC[79D ESC[K` — seventy-nine
 * columns left, erase to the end of the line — so a line that wraps past that
 * leaves its first row behind on every repaint. The figure is the server's,
 * not a guess about a terminal.
 */
export const STATLINE_MAX_CELLS = 79;

/** What an unknown figure is drawn as: never a zero, which would lie. */
const UNKNOWN = '?';

/** The tags a layout may draw a figure with, in the order the designer lists them. */
export const FIGURE_TAGS = [
  'hp',
  'hpMax',
  'mana',
  'manaMax',
  'exp',
  'need',
  'wealth',
  'state',
  'level',
  'room',
  'lives',
  'expSession'
] as const;
const FIGURE_TAG_SET: ReadonlySet<string> = new Set(FIGURE_TAGS);

const HEX = /^#[0-9a-f]{6}$/i;
const TAG = /\{([^{}]{1,40})\}/g;

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

function figureText(tag: string, figures: StatlineFigures): string {
  switch (tag) {
    case 'state':
      return figures.state === 'resting'
        ? ' (Resting)'
        : figures.state === 'meditating'
          ? ' (Meditating)'
          : '';
    case 'room':
      return figures.room ?? UNKNOWN;
    default: {
      const value = figures[tag as keyof StatlineFigures];
      return typeof value === 'number' ? String(value) : UNKNOWN;
    }
  }
}

/**
 * Cells a string paints in a fixed grid: emoji and East Asian wide characters
 * take two, marks, joiners and variation selectors none. An approximation of
 * the terminal's own measurement, used only to hold the line under the
 * repaint's seventy-nine columns.
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

/**
 * The line a design draws for these figures, as runs with their attributes
 * and the cells they take, or null for an empty layout. A line wider than
 * `STATLINE_MAX_CELLS` is the caller's to refuse, with the figure in hand.
 *
 * A figure with bands wears its band's colour for its own characters only
 * and hands the layout's colour back afterwards; a figure whose maximum is
 * unknown wears no band, since an unknown share is not a safe one.
 */
export function renderStatline(
  design: StatlineDesign,
  figures: StatlineFigures
): { segments: StatlineSegment[]; cells: number } | null {
  const layout = design.layout;
  if (layout.trim().length === 0) return null;

  const segments: StatlineSegment[] = [];
  let fg: string | null = null;
  let bg: string | null = null;
  let bold = false;
  let dim = false;
  const push = (text: string, colour: string | null = fg): void => {
    if (text.length === 0) return;
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
    if (FIGURE_TAG_SET.has(tag)) {
      const band =
        tag === 'hp'
          ? bandFor(design.bands.hp, figures.hp, figures.hpMax)
          : tag === 'mana'
            ? bandFor(design.bands.mana, figures.mana, figures.manaMax)
            : null;
      push(figureText(tag, figures), band ?? fg);
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

  return { segments, cells: cellsOf(segments.map((segment) => segment.text).join('')) };
}

/**
 * What the client tracks, in the shape a design draws from. A prompt's own
 * reading is laid over this by the caller, since the prompt is fresher than
 * the state it has not yet been applied to.
 */
export function figuresOf(state: CharacterState): StatlineFigures {
  return {
    hp: state.vitals.hp,
    hpMax: state.vitals.hpMax,
    mana: state.vitals.mana,
    manaMax: state.vitals.manaMax,
    exp: state.progress.exp,
    need: state.progress.expNeeded,
    wealth: state.inventory.wealth,
    state: state.vitals.meditating ? 'meditating' : state.vitals.resting ? 'resting' : null,
    level: state.progress.level,
    room: state.room.name,
    lives: state.progress.lives,
    expSession: state.progress.expThisSession
  };
}

/**
 * The state's figures with a prompt's reading laid over them: every figure
 * the prompt states wins, and `state` is the prompt's even when null, because
 * an idle prompt is a statement and not an absence.
 */
export function withReading(known: StatlineFigures, read: StatlineReading): StatlineFigures {
  return {
    ...known,
    hp: read.hp ?? known.hp,
    hpMax: read.hpMax ?? known.hpMax,
    mana: read.mana ?? known.mana,
    manaMax: read.manaMax ?? known.manaMax,
    exp: read.exp ?? known.exp,
    need: read.need ?? known.need,
    wealth: read.wealth ?? known.wealth,
    state: read.state
  };
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
 * whatever the server prints after the prompt starts clean.
 */
export function toAnsi(segments: readonly StatlineSegment[]): string {
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
