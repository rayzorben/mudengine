/**
 * A line typed in the terminal that the client reads itself (todo 83), one
 * that opens on an alias (todo 74), or `alias` (todo 134). The terminal sends
 * each key as it is typed, so at Enter the server already holds `get all`;
 * GreaterMUD's line editor takes back one character per `\b` and echoes the
 * erase (`TGS.Server/TGSModule.cs`), so the line is erased there instead of
 * committed, and handed to `MacroRunner`. MajorMUD's editor is unmeasured.
 */
import { aliasCommandOf } from '../../shared/aliasCommand';
import { expandAlias, type Aliases } from '../../shared/aliases';
import { asTyped } from '../../shared/clientCommands';
import { runsItself } from '../../shared/macroSteps';

export interface TakenBack {
  /** What erases the line the server holds. */
  erase: string;
  /** The line, for `MacroRunner`. */
  line: string;
}

/**
 * Whether a line the server already holds, typed in the terminal, is taken
 * back at Enter and read by main: one command main runs itself, a line that
 * opens on one of the player's aliases, the `alias` command, or one marked
 * `AS_TYPED` whose mark has to come off. A `;` line typed there goes out as
 * typed, as it always has.
 */
export function caughtInTerminal(line: string, aliases: Aliases): boolean {
  const bare = asTyped(line) ?? line;
  return runsItself(bare) || expandAlias(bare, aliases) !== null || aliasCommandOf(bare) !== null;
}

/**
 * What to send instead of `chunk` when it is a bare Enter committing
 * `outbound` (the shadow of the server's line), or null where it goes as is.
 */
export function takeBackAtEnter(
  outbound: string,
  chunk: string,
  aliases: Aliases
): TakenBack | null {
  if (!/^(?:\r\n?|\n)$/.test(chunk)) return null;
  const line = outbound.trim();
  if (!caughtInTerminal(line, aliases)) return null;
  return { erase: '\b'.repeat(outbound.length), line };
}
