/**
 * Lines the client runs itself instead of sending (todo 83), matched on the
 * whole line in any case. GreaterMUD has no `all` for either verb: `get` and
 * `equip` read it as an item's name (`GetCommand.cs`, `EquipCommand.cs`), so
 * nothing the server does is shadowed. Pure, so the Talk box can choose the
 * path and main can read the same line again. Closed: a new one is a member
 * here and a case in `session/clientCommands.ts`.
 */

import { parseMacro, placeholdersIn, type MacroStep } from './macro';
import { channelPrefix } from './talk';

export type ClientCommand = 'get-all' | 'equip-all';

/** The words each is typed as. Beside the type, so the two change together. */
export const CLIENT_COMMANDS: Readonly<Record<ClientCommand, string>> = {
  'get-all': 'get all',
  'equip-all': 'equip all'
};

const BY_WORDS = new Map(
  (Object.entries(CLIENT_COMMANDS) as Array<[ClientCommand, string]>).map(([name, words]) => [
    words,
    name
  ])
);

/** The client command a line is, or null where it goes to the server. */
export function clientCommandOf(line: string): ClientCommand | null {
  return BY_WORDS.get(line.trim().toLowerCase().replace(/\s+/g, ' ')) ?? null;
}

/**
 * The mark that sends a line to the server as typed, without it: a backslash
 * then `get all` is the server's own `get all`, and before `a {mob}` it sends
 * the braces.
 */
export const AS_TYPED = '\\';

/** The line to send as typed, the mark taken off, or null where it carries none. */
export function asTyped(line: string): string | null {
  const start = line.trimStart();
  return start.startsWith(AS_TYPED) ? start.slice(AS_TYPED.length) : null;
}

/** Whether main runs one command itself: a client command or a placeholder, never speech. */
function runsItself(line: string): boolean {
  const whole = line.trim();
  if (channelPrefix(whole) !== null) return false;
  return clientCommandOf(whole) !== null || placeholdersIn(whole).length > 0;
}

/**
 * The steps main runs a Talk-box line as, or null where it goes out as typed:
 * a line of several (`parseMacro`), a client command, or one step with a
 * placeholder. Speech on a channel and a line marked `AS_TYPED` are never any
 * of them.
 */
export function stepsOf(line: string): MacroStep[] | null {
  if (asTyped(line) !== null) return null;
  const several = parseMacro(line);
  if (several !== null) return several;
  return runsItself(line) ? [{ command: line.trim(), times: 1 }] : null;
}

/** Whether a Talk-box line goes to main to be read (`queueMacro`) rather than out as typed. */
export function mainReads(line: string): boolean {
  return asTyped(line) !== null || stepsOf(line) !== null;
}

/**
 * Whether a line the server already holds, typed in the terminal, is taken
 * back at Enter and read by main: one command main runs itself, or one marked
 * `AS_TYPED` whose mark has to come off. A `;` line typed there goes out as
 * typed, as it always has.
 */
export function caughtInTerminal(line: string): boolean {
  return runsItself(asTyped(line) ?? line);
}
