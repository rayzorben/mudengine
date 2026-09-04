/**
 * The UI dictionary's lookup: every word the chrome shows, found by key.
 *
 * The words themselves live in `locales/ui.en.yaml` and nowhere else — the
 * same rule `tokens.css` states for colours. A component asks
 * `t('cards.inventory.showAll')` rather than carrying the sentence, so the
 * client's whole vocabulary can be read, audited against
 * `docs/terminology.md` and reworded in one file without touching layout code.
 *
 * This module is the pure half. It deliberately reads and parses nothing —
 * `src/shared` stays dependency-free — so each process's own loader
 * (`src/renderer/src/lib/i18n.ts`) parses the YAML and hands the value in
 * here, through `asUiDict` first: the dictionary is parsed into the typed
 * shape or refused whole, never merely assumed.
 *
 * A missing key is never silent. The key itself is returned — visibly wrong
 * on screen rather than an empty gap — and reported once through the loader's
 * reporter. `i18n-coverage.test.ts` then makes both directions a build
 * failure: a `t()` call naming a key the YAML does not have, and a YAML key
 * nothing reads. A fact nobody reads is a fact the client does not have, and
 * a word nobody can see is the same defect in the other direction.
 */

/** A parsed dictionary: nested sections whose leaves are the strings shown. */
export type UiDict = { readonly [key: string]: string | UiDict };

/** Values spliced into a string's `{name}` placeholders. */
export type UiParams = Readonly<Record<string, string | number>>;

/** The lookup itself: `t('cards.room.title')`, `t('x.y', { name: 'Vex' })`. */
export type UiLookup = (key: string, params?: UiParams) => string;

/**
 * Parse an unknown value into a dictionary, or refuse it.
 *
 * Every leaf must be a string: a number, an array or a null in the YAML is a
 * malformed dictionary, and honouring part of one would hide the defect until
 * whichever screen reads the broken branch. Parse, do not validate — the
 * caller gets the typed value or `null`, never a value that only looked right.
 */
export function asUiDict(value: unknown): UiDict | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, string | UiDict> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      out[key] = entry;
      continue;
    }
    const branch = asUiDict(entry);
    if (branch === null) return null;
    out[key] = branch;
  }
  return out;
}

/** Flatten nested sections into `dot.path` keys, the shape `t()` is asked in. */
export function flattenDict(dict: UiDict, prefix = ''): Map<string, string> {
  const flat = new Map<string, string>();
  for (const [key, entry] of Object.entries(dict)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof entry === 'string') flat.set(path, entry);
    else for (const [inner, text] of flattenDict(entry, path)) flat.set(inner, text);
  }
  return flat;
}

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/**
 * Turn a parsed dictionary into the lookup.
 *
 * `report` is how a defect says it out loud — a missing key, or a placeholder
 * the call site gave no value for. Each distinct problem is reported once, not
 * once per render: the console saying the same thing sixty times a second is
 * a console nobody reads.
 */
export function makeT(dict: UiDict, report: (problem: string) => void): UiLookup {
  const flat = flattenDict(dict);
  const reported = new Set<string>();
  const say = (problem: string): void => {
    if (reported.has(problem)) return;
    reported.add(problem);
    report(problem);
  };

  return (key, params) => {
    const text = flat.get(key);
    if (text === undefined) {
      say(`no copy for key '${key}'`);
      return key;
    }
    if (params === undefined) return text;
    return text.replace(PLACEHOLDER, (whole, name: string) => {
      const value = params[name];
      if (value === undefined) {
        say(`no value for {${name}} in '${key}'`);
        return whole;
      }
      return String(value);
    });
  };
}
