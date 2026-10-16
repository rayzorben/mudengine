/**
 * The keys and alias words on a settings page that reach themselves through
 * the macros they call (todo 134), found across both lists, since a key and
 * an alias may call each other. On a character's page its own rows are laid
 * over what it inherits, so a loop through Global's macros is found too. Each
 * row says so, as the load notice does.
 */
import { useMemo } from 'react';

import type { Aliases } from '@shared/aliases';
import type { KeyBindings } from '@shared/keys';
import { loopingIn } from '@shared/macroBook';
import { pairsRecord, type StatedPair } from '@shared/pairs';
import { macroBlocks } from '@shared/profiles';

const NOTHING: { keys: KeyBindings; aliases: Aliases } = { keys: {}, aliases: {} };

export function useLoopingMacros(
  keys: readonly StatedPair[],
  aliases: readonly StatedPair[],
  inherited: { keys: KeyBindings; aliases: Aliases } = NOTHING
): ReadonlySet<string> {
  return useMemo(() => {
    const own = { keys: pairsRecord(keys), automation: { aliases: pairsRecord(aliases) } };
    const base = { keys: inherited.keys, automation: { aliases: inherited.aliases } };
    const blocks = macroBlocks(own, base);
    return loopingIn(blocks.keys, blocks.aliases);
  }, [keys, aliases, inherited]);
}
