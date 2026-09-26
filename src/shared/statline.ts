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
import { figure } from './values';
import { escapeRegExp } from './regex';

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
      source += escapeRegExp(ch);
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
/*
 * ───────────────────────────── the figures a design draws from ────────────
 *
 * The client intercepts the prompt, reads the real figures out of it, and
 * hands them with what it tracks beside them to the rewrite that draws the
 * prompt row (`rewrites.ts`, `template.ts`) — rendered at write time, never
 * as a transform over the buffer, so scrollback keeps whatever was drawn
 * then. `mudengine-ui` § The status line the player designs is drawn at
 * write time, in the prompt row.
 */

/** Everything a design may draw: the prompt's figures and what the client tracks beside them. */
export interface StatlineFigures extends StatlineReading {
  name: string | null;
  fullName: string | null;
  race: string | null;
  className: string | null;
  manaType: 'MA' | 'KAI' | null;
  level: number | null;
  room: string | null;
  lives: number | null;
  expSession: number | null;
  encumbrance: number | null;
  encumbranceMax: number | null;
  encumbranceWord: string | null;
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
    name: state.name,
    fullName: state.fullName,
    race: state.race,
    className: state.className,
    manaType: state.vitals.manaType,
    level: state.progress.level,
    room: state.room.name,
    lives: state.progress.lives,
    expSession: state.progress.expThisSession,
    encumbrance: state.inventory.encumbrance,
    encumbranceMax: state.inventory.encumbranceMax,
    encumbranceWord: state.inventory.encumbranceWord
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
