/**
 * A player's own shorthand (todo 74): a word typed alone, or in front of
 * arguments, stands for a line. The line may be several commands
 * (`shared/macro.ts`), which is how a named macro is written: `ret: 2d,6s;rest`.
 *
 * Pure, so main expands the line it is handed and the settings page can say
 * which entries load. One pass: an expansion is never expanded again, so two
 * aliases naming each other cannot loop. `docs/mudplay/13` is the reasoning.
 */

import { COMMAND_WORDS } from './commands';
import type { UiLookup } from './i18n';
import { statedPairs, type StatedPair } from './pairs';
import { channelPrefix } from './talk';

/** Word to line, the word lower case. */
export type Aliases = Readonly<Record<string, string>>;

/** Longer than any word the realm's table spells (`broadcast`), and short enough to type. */
const WORD = /^[a-z][a-z0-9]{0,15}$/;

/** Why an entry in the file does not load. Closed; the settings page words each. */
export type AliasRefusal = 'word' | 'empty' | 'command' | 'twice';

/** Why `word` cannot stand for `line`, or null when it loads. */
export function aliasRefusal(word: string, line: string): AliasRefusal | null {
  const spelled = word.trim().toLowerCase();
  if (!WORD.test(spelled)) return 'word';
  if (line.trim().length === 0) return 'empty';
  /*
   * A word the realm already accepts (`l`, `gos`, `k`) is never taken over:
   * the client would then send something other than what the player typed in
   * front of a command the server knows.
   */
  if (Object.hasOwn(COMMAND_WORDS, spelled)) return 'command';
  return null;
}

/** Why an entry does not load, in words, for the page and the load notice. */
export function aliasRefusalText(refusal: AliasRefusal, t: UiLookup): string {
  switch (refusal) {
    case 'word':
      return t('settings.aliases.refusal.word');
    case 'empty':
      return t('settings.aliases.refusal.empty');
    case 'command':
      return t('settings.aliases.refusal.command');
    case 'twice':
      return t('settings.aliases.refusal.twice');
    default: {
      const never: never = refusal;
      return never;
    }
  }
}

/**
 * Why each row does not load, in order, null for one that does. Two rows on
 * one word (`kk` and `KK`) are a clash: neither loads.
 */
export function aliasRowRefusals(pairs: readonly StatedPair[]): Array<AliasRefusal | null> {
  const words = pairs.map((pair) => pair.name.trim().toLowerCase());
  return pairs.map((pair, index) => {
    const own = aliasRefusal(pair.name, pair.text);
    if (own !== null) return own;
    return words.filter((word) => word === words[index]).length > 1 ? 'twice' : null;
  });
}

/** The entries that load, keyed lower case. Anything not a word-to-text map is none. */
export function normalizeAliases(raw: unknown): Aliases {
  const pairs = statedPairs(raw);
  const refusals = aliasRowRefusals(pairs);
  const kept: Record<string, string> = {};
  pairs.forEach(({ name, text }, index) => {
    if (refusals[index] === null) kept[name.trim().toLowerCase()] = text.trim();
  });
  return kept;
}

/**
 * The entries a file states that do not load, each with why. `word: ''` is
 * left out: in a character's file it drops an inherited alias, which is the
 * one thing an empty line is for.
 */
export function refusedAliases(raw: unknown): Array<StatedPair & { refusal: AliasRefusal }> {
  const pairs = statedPairs(raw);
  const refusals = aliasRowRefusals(pairs);
  return pairs.flatMap((pair, index) => {
    const refusal = refusals[index] ?? null;
    return refusal === null || refusal === 'empty' ? [] : [{ ...pair, refusal }];
  });
}

/**
 * The line an alias stands for, with whatever followed the word put after it,
 * or null where the line opens on no alias. Speech is never expanded: a
 * channel's message is the player's own words.
 */
export function expandAlias(line: string, aliases: Aliases): string | null {
  const text = line.trim();
  if (channelPrefix(text) !== null) return null;
  const space = text.search(/\s/);
  const word = (space < 0 ? text : text.slice(0, space)).toLowerCase();
  const expansion = Object.hasOwn(aliases, word) ? aliases[word] : undefined;
  if (expansion === undefined) return null;
  const rest = space < 0 ? '' : text.slice(space + 1).trim();
  return rest.length === 0 ? expansion : `${expansion} ${rest}`;
}
