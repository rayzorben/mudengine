/**
 * Spellings the server is seen to run where an earlier one for the same thing
 * does not. Every reader types the first spelling of a room's command, an
 * exit's action or a quest step, so a list holding one of these puts it first.
 * Read by `readLines` (text blocks) and `phrasesOf` (exit columns).
 */

/**
 * Each a phrase or the words it opens with. MajorMUD v1.11p runs none of the
 * other spellings (the user, live, 2026-11-27):
 *
 * - `get roots` in the Earthy Cave (9/500) is read as the server's own get
 *   command and hands over no cave roots; `cut roots`, on the same block 1446,
 *   does. `pick` is the picklock command, and `pull` and `grab` are not
 *   captured.
 * - In the catacombs only `aim fork <direction>` opens the hidden exit the
 *   titanium fork points at; `use fork` and `use titanium fork` do not.
 */
const TYPED_FIRST: readonly string[] = ['cut roots', 'aim fork'];

/** Whether the server is seen to run this phrase where its other spellings fail. */
function isTypedFirst(phrase: string): boolean {
  return TYPED_FIRST.some((words) => phrase === words || phrase.startsWith(`${words} `));
}

/** The list with every entry whose phrase is `TYPED_FIRST` ahead, each half in its order. */
export function typedFirst<T>(entries: readonly T[], phraseOf: (entry: T) => string | null): T[] {
  const first = (entry: T): boolean => isTypedFirst(phraseOf(entry) ?? '');
  return [...entries.filter(first), ...entries.filter((entry) => !first(entry))];
}
