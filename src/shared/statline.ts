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
 * which is a fact. The grammar is `template.ts`, shared with every other
 * rewrite. `mudengine-ui` § The status line the player designs is drawn at
 * write time, in the prompt row.
 */
import { bandFor, renderTemplate, type Cell, type ColourBand, type Segment } from './template';

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
export const UNKNOWN = '?';

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
): { segments: Segment[]; cells: number } | null {
  const drawn = renderTemplate(design.layout, (tag): Cell | null => {
    if (!FIGURE_TAG_SET.has(tag)) return null;
    const band =
      tag === 'hp'
        ? bandFor(design.bands.hp, figures.hp, figures.hpMax)
        : tag === 'mana'
          ? bandFor(design.bands.mana, figures.mana, figures.manaMax)
          : null;
    return { text: figureText(tag, figures), colour: band };
  });
  return drawn === null ? null : { segments: drawn.segments, cells: drawn.cells };
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
