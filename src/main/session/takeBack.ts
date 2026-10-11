/**
 * A line typed in the terminal that the client reads itself (todo 83), or
 * one that opens on an alias (todo 74). The terminal sends each key as it is
 * typed, so at Enter the server already holds `get all`; GreaterMUD's line
 * editor takes back one character per `\b` and echoes the erase
 * (`TGS.Server/TGSModule.cs`), so the line is erased there instead of
 * committed, and handed to `queueMacro`. MajorMUD's editor is unmeasured.
 */
import type { Aliases } from '../../shared/aliases';
import { caughtInTerminal } from '../../shared/clientCommands';

export interface TakenBack {
  /** What erases the line the server holds. */
  erase: string;
  /** The line, for `queueMacro`. */
  line: string;
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
