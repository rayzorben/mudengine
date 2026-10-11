/**
 * A block the player writes as a map of a name to a line, as the file states
 * it and before anything is refused: `automation.aliases` and `keys` (todo 74).
 * The settings page edits these rows, so an entry that does not load is still
 * shown with its reason instead of vanishing on the next save.
 */

import { isRecord } from './values';

/** One entry, in the file's order. */
export interface StatedPair {
  name: string;
  text: string;
}

/**
 * Every entry, as written. YAML reads `F5: 1` as a number, so a number or a
 * yes/no is its text; a list or a map is no line. Anything not a map is none.
 */
export function statedPairs(raw: unknown): StatedPair[] {
  if (!isRecord(raw)) return [];
  return Object.entries(raw).flatMap(([name, text]) =>
    typeof text === 'string'
      ? [{ name, text }]
      : typeof text === 'number' || typeof text === 'boolean'
        ? [{ name, text: String(text) }]
        : []
  );
}

/** The rows as the map the file holds; a row with no name is not written, a later one wins. */
export function pairsRecord(pairs: readonly StatedPair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, text } of pairs) {
    const key = name.trim();
    if (key.length > 0) out[key] = text;
  }
  return out;
}

/** The rows a form sent, each a name and a text; anything else is dropped. */
export function asStatedPairs(value: unknown): StatedPair[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) =>
    isRecord(row) && typeof row['name'] === 'string' && typeof row['text'] === 'string'
      ? [{ name: row['name'], text: row['text'] }]
      : []
  );
}
