/**
 * Keys the player binds to a line, MegaMUD's macros (todo 74): `keys:` maps
 * a chord to a macro (`macroSteps.ts`), sent the way a Talk-box line is, so a
 * key bound to an alias or to a `;` line paces like any macro. A character's
 * file adds its own over the options file's, key by key, and an empty line
 * drops one (todo 134), as aliases are layered.
 *
 * A chord names the physical key (`KeyboardEvent.code`), so Numpad 8 walks
 * north with NumLock on or off and the top-row 8 still types an 8. The
 * client's own chords are listed here too (`CLIENT_KEYS`), read by each table
 * that binds one, so a binding on one of them is refused by name.
 */

import type { UiLookup } from './i18n';
import { lineFault, macroRefusalText, type MacroRefusal } from './macroSteps';
import { statedPairs, type StatedPair } from './pairs';

/** One chord: modifiers and the physical key. `mod` is Ctrl, or Cmd on macOS. */
export interface Chord {
  code: string;
  mod: boolean;
  alt: boolean;
  shift: boolean;
}

/** Chord, spelled as `chordName` writes it, to line. */
export type KeyBindings = Readonly<Record<string, string>>;

/** What MegaMUD 2.1 ships in `Default/MACROS.md`: the keypad walks, 5 maps, + rests. */
export const MEGAMUD_KEYS: KeyBindings = {
  Numpad1: 'sw',
  Numpad2: 's',
  Numpad3: 'se',
  Numpad4: 'w',
  Numpad5: 'map',
  Numpad6: 'e',
  Numpad7: 'nw',
  Numpad8: 'n',
  Numpad9: 'ne',
  Numpad0: 'u',
  NumpadDecimal: 'd',
  NumpadAdd: 'rest'
};

/** A chord as `useHotkeys` takes it: `key` is `KeyboardEvent.key`. */
export interface ClientChord {
  key: string;
  mod?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** The chords the client's own window keys answer to. Closed; each table reads its own. */
export type ClientKey =
  | 'palette'
  | 'loops'
  | 'rail'
  | 'latest'
  | 'density'
  | 'densityComma'
  | 'theme'
  | 'search'
  | 'pane'
  | 'nextTab'
  | 'previousTab'
  | 'route'
  | 'settings'
  | 'connection'
  | 'hangUp'
  | 'hangUpQuit'
  | 'runRoute'
  | 'walkRoute';

export const CLIENT_KEYS: Readonly<Record<ClientKey, ClientChord>> = {
  palette: { key: 'k', mod: true },
  loops: { key: 'l', mod: true },
  rail: { key: 'd', mod: true, shift: true },
  latest: { key: 'l', mod: true, shift: true },
  // Shift , is `<` on a US board and `,` on others.
  density: { key: '<', mod: true, shift: true },
  densityComma: { key: ',', mod: true, shift: true },
  theme: { key: 't', mod: true, shift: true },
  search: { key: 'f', mod: true },
  pane: { key: '\\', mod: true },
  nextTab: { key: 'Tab', mod: true },
  previousTab: { key: 'Tab', mod: true, shift: true },
  route: { key: 'g', mod: true },
  settings: { key: ',', mod: true },
  connection: { key: 'Enter', mod: true },
  hangUp: { key: 'h', alt: true },
  hangUpQuit: { key: 'q', mod: true },
  // The route panel's, only while a plan is on screen.
  runRoute: { key: 'r', alt: true },
  walkRoute: { key: 'g', alt: true }
};

/** The punctuation `CLIENT_KEYS` names, by the physical key it sits on. */
const PUNCTUATION_CODES: Readonly<Record<string, string>> = {
  ',': 'Comma',
  '<': 'Comma',
  '\\': 'Backslash'
};

/** The physical key a `ClientChord` sits on; `useHotkeys` matches an Alt chord by it. */
export function codeOfKey(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  return PUNCTUATION_CODES[key] ?? key;
}

/** Copy, paste, cut, select and undo: every field and the console need them. */
const EDITING: readonly Chord[] = ['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyY', 'KeyZ'].flatMap(
  (code) => [
    { code, mod: true, alt: false, shift: false },
    { code, mod: true, alt: false, shift: true }
  ]
);

const TAKEN: ReadonlySet<string> = new Set([
  ...Object.values(CLIENT_KEYS).map((chord) =>
    chordName({
      code: codeOfKey(chord.key),
      mod: chord.mod ?? false,
      alt: chord.alt ?? false,
      shift: chord.shift ?? false
    })
  ),
  ...EDITING.map(chordName)
]);

/** The keys a bare press of which may be bound: the keypad and the function row. */
const BARE_OK = /^(?:Numpad(?:\d|Decimal|Add|Subtract|Multiply|Divide)|F\d{1,2})$/;

/** Whether `word` names a key a bare press of which may be bound (`f2`, `numpad8`), in any case. */
export function isBareKeyName(word: string): boolean {
  const chord = parseChord(word);
  return (
    chord !== null && BARE_OK.test(chord.code) && word.toLowerCase() === chord.code.toLowerCase()
  );
}

/** A physical key's name: `Numpad8`, `KeyK`, `F5`, `Comma`. */
const CODE = /^[A-Z][A-Za-z0-9]*$/;

/** The chord a file spells (`Ctrl+Shift+KeyK`, `numpad8`), or null where it spells none. */
export function parseChord(text: string): Chord | null {
  const parts = text.split('+').map((part) => part.trim());
  const last = parts.pop() ?? '';
  const code = last.length > 0 ? last[0]!.toUpperCase() + last.slice(1) : '';
  if (!CODE.test(code)) return null;
  const chord: Chord = { code, mod: false, alt: false, shift: false };
  for (const part of parts) {
    const word = part.toLowerCase();
    const flag = word === 'ctrl' || word === 'cmd' ? 'mod' : word === 'alt' ? 'alt' : word;
    if ((flag !== 'mod' && flag !== 'alt' && flag !== 'shift') || chord[flag]) return null;
    chord[flag] = true;
  }
  return chord;
}

/** The name a key is filed under (`f2` is `F2`), or null where it names no key. */
export function keyName(text: string): string | null {
  const chord = parseChord(text);
  return chord === null ? null : chordName(chord);
}

/** How a chord is written in the file and shown on the page. */
export function chordName(chord: Chord): string {
  const mods = [chord.mod && 'Ctrl', chord.alt && 'Alt', chord.shift && 'Shift'];
  return [...mods.filter(Boolean), chord.code].join('+');
}

/** The chord a key press is, from the fields every `KeyboardEvent` carries. */
export function chordOfEvent(event: {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): Chord {
  return {
    code: event.code,
    mod: event.ctrlKey || event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey
  };
}

/** Why an entry in `keys:` does not load. Closed; the page and the load notice word each. */
export type KeyRefusal =
  | 'chord'
  | 'empty'
  | 'twice'
  | 'client'
  | 'typing'
  /** Refused for a reason a key and an alias share. */
  | MacroRefusal;

/** One entry of the file that does not load. */
export interface RefusedKey {
  name: string;
  refusal: KeyRefusal;
}

/** Why an entry does not load, in words, for the page and the load notice. */
export function keyRefusalText(refusal: KeyRefusal, t: UiLookup): string {
  switch (refusal) {
    case 'chord':
      return t('settings.keys.refusal.chord');
    case 'empty':
      return t('settings.keys.refusal.empty');
    case 'twice':
      return t('settings.keys.refusal.twice');
    case 'client':
      return t('settings.keys.refusal.client');
    case 'typing':
      return t('settings.keys.refusal.typing');
    case 'shape':
    case 'line':
    case 'loops':
      return macroRefusalText(refusal, t);
    default: {
      const never: never = refusal;
      return never;
    }
  }
}

/** Why a chord on its own cannot be bound, or null. */
function chordRefusal(chord: Chord): KeyRefusal | null {
  if (TAKEN.has(chordName(chord))) return 'client';
  // A bare key or a shifted one types into the line, or is Enter, Tab, Escape.
  if (!chord.mod && !chord.alt && !BARE_OK.test(chord.code)) return 'typing';
  return null;
}

/**
 * Why each row does not load, in order, null for one that does. Two rows on
 * one chord (`Numpad8` and `numpad8`) are a clash: neither loads. `looping`
 * holds the chords that reach themselves (`loopingMacros`).
 */
export function keyRowRefusals(
  pairs: readonly StatedPair[],
  looping: ReadonlySet<string> = new Set()
): Array<KeyRefusal | null> {
  const chords = pairs.map((pair) => parseChord(pair.name));
  const count = new Map<string, number>();
  for (const chord of chords) {
    if (chord !== null) count.set(chordName(chord), (count.get(chordName(chord)) ?? 0) + 1);
  }
  return pairs.map((pair, index) => {
    const chord = chords[index] ?? null;
    if (chord === null) return 'chord';
    if (pair.shape === true) return 'shape';
    if (pair.text.trim().length === 0) return 'empty';
    if ((count.get(chordName(chord)) ?? 0) > 1) return 'twice';
    const own = chordRefusal(chord);
    if (own !== null) return own;
    if (lineFault(pair.text) !== null) return 'line';
    return looping.has(chordName(chord)) ? 'loops' : null;
  });
}

/** What a `keys:` block loads, and every entry it refuses with why. */
export function readKeys(
  raw: unknown,
  looping: ReadonlySet<string> = new Set()
): { bindings: KeyBindings; refused: RefusedKey[] } {
  const pairs = statedPairs(raw);
  const refusals = keyRowRefusals(pairs, looping);
  const bindings: Record<string, string> = {};
  const refused: RefusedKey[] = [];
  pairs.forEach(({ name, text }, index) => {
    const refusal = refusals[index] ?? null;
    const key = keyName(name);
    if (refusal !== null) refused.push({ name, refusal });
    else if (key !== null) bindings[key] = text.trim();
  });
  return { bindings, refused };
}

/** A file with no `keys:` block has MegaMUD's; one that states the block has what it says. */
export function keyBlock(raw: unknown): unknown {
  return raw === undefined ? MEGAMUD_KEYS : raw;
}

/** The bindings that load; anything not a map is none. See `readKeys`. */
export function normalizeKeys(raw: unknown, looping: ReadonlySet<string> = new Set()): KeyBindings {
  return readKeys(keyBlock(raw), looping).bindings;
}

/** The rows a `keys:` block states, as written; MegaMUD's set where the file has no block. */
export function statedKeys(raw: unknown): StatedPair[] {
  return statedPairs(keyBlock(raw));
}
