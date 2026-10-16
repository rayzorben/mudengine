/**
 * A talk-box line that stands for several commands (todo 04), and a macro's
 * own text (todo 134).
 *
 * `;` separates commands, `6s` is `s` six times, and `2d,6s,3u` is three of
 * those in one piece. A comma only joins repeats: a piece whose every
 * comma-separated part is `<count><command>` is split, and anything else —
 * `say hi, all` — is one command with its comma. A line that opens on a
 * channel is speech and is never split. A macro written as a list holds one
 * command an entry (`pairs.ts` joins them a line each), and nothing in an
 * entry is split on `;`, so `gos gg ;)` stays one command. Pure, so the box
 * can decide with it which path a line takes and main can parse the same
 * line again rather than trust a list off the wire. `mudengine-ui` › *The
 * Talk card*.
 */

import { GUARD_FIELDS } from './rules';
import { channelPrefix } from './talk';

/** One command and how many times it goes out. */
export interface MacroPiece {
  command: string;
  times: number;
}

/** A count, then a command that starts with a letter: `6s`, `2ne`, `3get torch`. */
const REPEAT = /^(\d+)([a-z].*)$/i;

function repeatOf(part: string): MacroPiece | null {
  const found = REPEAT.exec(part);
  if (found === null) return null;
  const times = Number(found[1]);
  if (!Number.isSafeInteger(times) || times < 1) return null;
  return { command: found[2]!.trim(), times };
}

/** One piece: its counted commands (`2d,6s`), or the piece as one command. */
function piecesOf(piece: string): MacroPiece[] {
  const repeats = piece.split(',').map((part) => repeatOf(part.trim()));
  return repeats.every((step): step is MacroPiece => step !== null)
    ? repeats
    : [{ command: piece, times: 1 }];
}

/**
 * The commands a line stands for, in order, or null where it is one command
 * with no directive in it, which the box sends exactly as typed.
 */
export function parseMacro(line: string): MacroPiece[] | null {
  // Speech carries `;)`, and `gos gg ;)` split would say `)` in the room.
  if (channelPrefix(line.trimStart()) !== null) return null;
  let directive = line.includes(';');
  const steps: MacroPiece[] = [];
  for (const piece of line.split(';')) {
    const trimmed = piece.trim();
    if (trimmed.length === 0) continue;
    const pieces = piecesOf(trimmed);
    if (pieces.length > 1 || pieces[0]!.command !== trimmed) directive = true;
    steps.push(...pieces);
  }
  return directive && steps.length > 0 ? steps : null;
}

/**
 * The commands a macro's text stands for, in order: a list's entries one a
 * line, or a line split as the Talk box splits it. Empty for blank text.
 */
export function macroLines(text: string): MacroPiece[] {
  if (text.includes('\n')) {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap(piecesOf);
  }
  const line = text.trim();
  if (line.length === 0) return [];
  return parseMacro(line) ?? [{ command: line, times: 1 }];
}

/**
 * The values a macro line may ask to be filled in when it goes out, beside
 * every field a rule's guard reads (`{hp}`, `{target}`), spelled as a rule
 * spells it: `{mob}` is the monster auto-combat would open on in the room the
 * character is in by then (todo 83); `{leader}` the player this character
 * follows, `{telepath}` the last player to telepath it, `{item}` the first
 * thing listed on the floor (todo 134).
 */
export const MACRO_PLACEHOLDERS = ['mob', 'leader', 'telepath', 'item'] as const;
export type MacroPlaceholder = (typeof MACRO_PLACEHOLDERS)[number];

/** What a macro line on its own can ask the client to do (todo 134). Closed; `macroSteps.ts`. */
export const MACRO_ACTIONS = ['goto', 'sneak'] as const;
export type MacroAction = (typeof MACRO_ACTIONS)[number];

const BRACED = /\{([^{}\s]+)\}/g;

/** Every `{name}` in a command, in order, known or not. */
export function placeholdersIn(command: string): string[] {
  return [...command.matchAll(BRACED)].map((found) => found[1]!);
}

/** Whether `name` is a value a line fills in: one of the macro's own or a guard field. */
export function isMacroValue(name: string): boolean {
  const known: readonly string[] = [...MACRO_PLACEHOLDERS, ...GUARD_FIELDS];
  return known.includes(name);
}

/**
 * Whether the client reads `word` in braces itself, as a value or an action,
 * in any case: an alias of that word could never be called (todo 134).
 */
export function isClientWord(word: string): boolean {
  const spelled = word.toLowerCase();
  const words: readonly string[] = [...MACRO_PLACEHOLDERS, ...MACRO_ACTIONS, ...GUARD_FIELDS];
  return words.some((each) => each.toLowerCase() === spelled);
}

/** The command with each `{name}` replaced by its value; `$` in a value is kept. */
export function fillValue(command: string, name: MacroPlaceholder, value: string): string {
  return command.split(`{${name}}`).join(value);
}
