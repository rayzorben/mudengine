/**
 * The macros a character has, for a `{name}` line to call (todo 134): its
 * keys by the chord's name (`{f2}` is `F2`, `{ctrl+keyk}` is `Ctrl+KeyK`) and
 * its aliases by their word. The two never share a name: an alias may not be
 * a key's name (`aliases.ts`).
 */

import { aliasWord, normalizeAliases, type Aliases } from './aliases';
import { keyName, normalizeKeys, type KeyBindings } from './keys';
import { loopingMacros, type MacroBook } from './macroSteps';
import { isRecord } from './values';

export function macroBook(keys: KeyBindings, aliases: Aliases): MacroBook {
  const entries = [
    ...Object.entries(keys).map(([id, text]) => ({ id, text })),
    ...Object.entries(aliases).map(([id, text]) => ({ id, text }))
  ];
  return {
    find: (name) => {
      const key = keyName(name);
      if (key !== null && Object.hasOwn(keys, key)) return { id: key, text: keys[key]! };
      const word = aliasWord(name);
      return Object.hasOwn(aliases, word) ? { id: word, text: aliases[word]! } : null;
    },
    entries: () => entries
  };
}

/**
 * The keys and alias words of the `keys:` and `automation.aliases` blocks a
 * file states that reach themselves, which neither loads: refused at load
 * rather than at the press, so the page and the load notice can say so.
 */
export function loopingIn(keys: unknown, aliases: unknown): ReadonlySet<string> {
  return loopingMacros(macroBook(normalizeKeys(keys), normalizeAliases(aliases)));
}

/**
 * A block's entries under the names they load as (`f2` as `F2`, `KK` as
 * `kk`), so a character's entry lays over Global's of the same key or word.
 * Two of one file that load as one name keep their own spelling, and are
 * refused as set twice.
 */
function filedUnder(block: unknown, name: (raw: string) => string | null): unknown {
  if (!isRecord(block)) return block;
  const names = Object.keys(block).map((raw) => name(raw) ?? raw);
  const out: Record<string, unknown> = {};
  Object.entries(block).forEach(([raw, value], at) => {
    const filed = names[at]!;
    out[names.filter((each) => each === filed).length > 1 ? raw : filed] = value;
  });
  return out;
}

/** A parsed file with its `keys:` and `automation.aliases` filed under the names they load as. */
export function withMacroNames<T>(file: T): T {
  if (!isRecord(file)) return file;
  const automation = file['automation'];
  // The same file with two blocks re-keyed, so its own type still describes it.
  return {
    ...file,
    ...(file['keys'] === undefined ? {} : { keys: filedUnder(file['keys'], keyName) }),
    ...(isRecord(automation) && automation['aliases'] !== undefined
      ? { automation: { ...automation, aliases: filedUnder(automation['aliases'], aliasWord) } }
      : {})
  } as T;
}
