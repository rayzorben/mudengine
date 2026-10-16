/**
 * `alias` and `unalias` typed in the game (todo 134): list, show, set and
 * remove this character's aliases without the settings screen. Read off the
 * whole typed line before anything splits it on `;`, so what follows the word
 * in `alias doit ne;recover corpse;sw` is the alias's line, kept exactly.
 * Neither word is a command on GreaterMUD (`PlayerCommands/`,
 * `shared/commands.ts`); `\alias` sends the word to the server. Closed; each
 * kind is a case in `session/aliasAnswers.ts`.
 */

import { channelPrefix } from './talk';

export type AliasCommand =
  | { kind: 'list' }
  | { kind: 'show'; word: string }
  | { kind: 'set'; word: string; line: string }
  | { kind: 'remove'; word: string }
  /** `unalias` with no word: what to type is said. */
  | { kind: 'usage' };

/** The words the command is typed as, which no alias may take. */
export const ALIAS_COMMAND_WORDS = ['alias', 'unalias'] as const;

/** The alias command a typed line is, or null where it is not one. */
export function aliasCommandOf(line: string): AliasCommand | null {
  const text = line.trim();
  if (channelPrefix(text) !== null) return null;
  const found = /^(\S+)(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/.exec(text);
  if (found === null) return null;
  const verb = found[1]!.toLowerCase();
  const word = found[2]?.toLowerCase();
  const rest = found[3]?.trim() ?? '';
  if (verb === 'alias') {
    if (word === undefined) return { kind: 'list' };
    return rest.length === 0 ? { kind: 'show', word } : { kind: 'set', word, line: rest };
  }
  if (verb === 'unalias') {
    return word === undefined || rest.length > 0 ? { kind: 'usage' } : { kind: 'remove', word };
  }
  return null;
}
