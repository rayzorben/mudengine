/**
 * `return` typed in the game: `return cretin` gives Cretin what this
 * character took out of their corpse with `recover`, and `return` alone lists
 * what is still carried and for whom. Read off the whole typed line, as `alias`
 * is. The word is not a command on GreaterMUD (`PlayerCommands/`,
 * `shared/commands.ts`), where it would be said out loud; `\return` sends it
 * to the server. Closed; each kind is a case in `session/returnAnswers.ts`.
 */

import { channelPrefix } from './talk';

export type ReturnCommand =
  | { kind: 'list' }
  | { kind: 'give'; player: string }
  /** More than one word after it: what to type is said. */
  | { kind: 'usage' };

/** The word the command is typed as, which no alias may take. */
export const RETURN_COMMAND_WORD = 'return';

/** The return command a typed line is, or null where it is not one. */
export function returnCommandOf(line: string): ReturnCommand | null {
  const text = line.trim();
  if (channelPrefix(text) !== null) return null;
  const [verb = '', player, ...more] = text.split(/\s+/);
  if (verb.toLowerCase() !== RETURN_COMMAND_WORD) return null;
  if (player === undefined) return { kind: 'list' };
  return more.length > 0 ? { kind: 'usage' } : { kind: 'give', player };
}
