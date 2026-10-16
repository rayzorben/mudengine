/**
 * Lines the client runs itself instead of sending (todo 83), matched on the
 * whole line in any case. GreaterMUD has no `all` for either verb: `get` and
 * `equip` read it as an item's name (`GetCommand.cs`, `EquipCommand.cs`), so
 * nothing the server does is shadowed. Pure, so the Talk box's line and the
 * terminal's are read by the same rules. Closed: a new one is a member here
 * and a case in `session/clientCommands.ts`. A macro step is one of these
 * (`macroSteps.ts`); `alias` takes words after it and is `aliasCommand.ts`.
 */

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
