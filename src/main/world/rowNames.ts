/**
 * The realm's row behind a printed monster name, for a caller holding a name
 * and no room occupant. The server hangs words on either end of a name at
 * spawn and the word never matters (`mudengine-automation` › combat).
 */
import type { WorldGraph } from './WorldGraph';

/** The row name `mobAsPrinted` finds, else the name as printed. */
export function mobRowName(
  world: Pick<WorldGraph, 'mobAsPrinted'> | undefined,
  name: string
): string {
  return world?.mobAsPrinted(name)?.name ?? name;
}
