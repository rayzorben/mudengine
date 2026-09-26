/**
 * The UI's copy as a pattern, for the tests and harnesses that look for it.
 * Shipped code recognises its own sentences with `isSaidBy` (`i18n.ts`), which
 * never throws.
 *
 * The dictionary (`locales/ui.en.yaml`) is the user's to reword at any time,
 * so nothing that checks behaviour may carry its English: an expectation names
 * a sentence by its key and matches whatever it currently says. A key the
 * dictionary lacks throws rather than rendering as itself, so a renamed key
 * can never turn a check that something was *not* said into one that passes
 * because nothing could match. Outside `__tests__` on purpose: the smokes
 * import it, and the gate wakes a smoke on a change to what it imports.
 */
import { templateParts } from '../../shared/i18n';
import { escapeRegExp } from '../../shared/regex';
import { t } from './i18n';

/** Figures filled into a sentence; a placeholder not named here matches anything. */
export type Known = Readonly<Record<string, string | number>>;

export interface MatchOptions {
  /** RegExp flags: a harness reading `innerText` wants `i`, since CSS may upper-case it. */
  readonly flags?: string;
  /** What an unnamed placeholder matches (by default, anything, as little as it can). */
  readonly fill?: string;
}

/** A figure left open inside a value given in `known`, such as a nested `t()`. */
export const ANY = '\u0000';

const OPEN = '[\\s\\S]*?';

/** What `key` renders with `params`; a key the dictionary lacks throws. */
export function copyOf(key: string, params?: Known): string {
  // `t` renders a missing key as the key itself, whatever the params.
  const text = t(key, params);
  if (text === key) throw new Error(`the dictionary has no copy for '${key}'`);
  return text;
}

/** A pattern from its source; built per call, since each is asked for once, in a test. */
const compile = (body: string, options: MatchOptions): RegExp => new RegExp(body, options.flags);

/**
 * `key`'s copy cut at its placeholders: the literal runs at even indices and
 * each placeholder's bare name between them, so a caller never re-learns the
 * dictionary's `{name}` syntax.
 */
export function partsOf(key: string): string[] {
  return templateParts(copyOf(key));
}

/** `key`'s own words, placeholders aside (see `partsOf`). */
export function literalsOf(key: string): string[] {
  return partsOf(key).filter((_, index) => index % 2 === 0);
}

function source(key: string, known: Known, fill: string): string {
  return partsOf(key)
    .map((part, index) => {
      if (index % 2 === 0) return escapeRegExp(part);
      const value = known[part];
      return value === undefined ? fill : String(value).split(ANY).map(escapeRegExp).join(OPEN);
    })
    .join('');
}

/**
 * What `key` renders, as a pattern found anywhere in a longer text: the
 * placeholders `known` names are filled exactly (but for any `ANY` inside
 * them), every other one matches `options.fill`.
 */
export function phrase(key: string, known: Known = {}, options: MatchOptions = {}): RegExp {
  return compile(source(key, known, options.fill ?? OPEN), options);
}

/** The same, as the whole of a text (see `phrase`). */
export function sentence(key: string, known: Known = {}, options: MatchOptions = {}): RegExp {
  return compile(`^(?:${source(key, known, options.fill ?? OPEN)})$`, options);
}

/** Any of several keys' copy, found anywhere in a text (see `phrase`). */
export function phraseOfAny(
  keys: readonly string[],
  known: Known = {},
  options: MatchOptions = {}
): RegExp {
  const fill = options.fill ?? OPEN;
  return compile(keys.map((key) => `(?:${source(key, known, fill)})`).join('|'), options);
}

/**
 * Whether rendered `text` is the whole of what `key` says, surrounding space
 * and casing aside: what a harness reads off the page, where a CSS
 * `text-transform` reaches `innerText`.
 */
export function isCopy(text: unknown, key: string, known: Known = {}): boolean {
  return sentence(key, known, { flags: 'i' }).test(String(text ?? '').trim());
}

/** Whether a message is the whole of one of the sentences `keys` render. */
export function composes(
  keys: string | readonly string[],
  known: Known = {}
): (message: string) => boolean {
  const shapes = [keys].flat().map((key) => sentence(key, known));
  return (message) => shapes.some((shape) => shape.test(message));
}

/** The messages in `heard` rendered from one of `keys`, whatever the copy says. */
export function notesOf(heard: readonly string[], ...keys: string[]): string[] {
  return heard.filter(composes(keys));
}
