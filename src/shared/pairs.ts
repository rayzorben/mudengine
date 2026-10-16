/**
 * A block the player writes as a map of a name to a line, as the file states
 * it and before anything is refused: `automation.aliases` and `keys` (todo 74).
 * The settings page edits these rows, so an entry that does not load is still
 * shown with its reason instead of vanishing on the next save.
 *
 * A value is a line (`ne;l;sw`) or a list, one command an entry (todo 134).
 * A row holds a list as its entries one a line, so the page's box edits it
 * and a save writes it back as a list.
 */

import { isRecord } from './values';

/** One entry, in the file's order. */
export interface StatedPair {
  name: string;
  /** The line, or a list's entries one a line. */
  text: string;
  /**
   * The file states something that is neither a line nor a list of lines (a
   * map, a list holding one). `text` is that value as JSON, written back as
   * it was until the row is edited.
   */
  shape?: true;
}

/** A YAML scalar as its text: `F5: 1` is a number, `yes` a boolean. */
function scalarText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** One entry's value as a row's text, or null where it is no line and no list of lines. */
function textOf(value: unknown): string | null {
  if (!Array.isArray(value)) return scalarText(value);
  const lines = value.map(scalarText);
  return lines.every((line): line is string => line !== null) ? lines.join('\n') : null;
}

/** Every entry, as written. Anything not a map is none. */
export function statedPairs(raw: unknown): StatedPair[] {
  if (!isRecord(raw)) return [];
  return Object.entries(raw).flatMap(([name, value]): StatedPair[] => {
    if (value === null || value === undefined) return [];
    const text = textOf(value);
    return text === null ? [{ name, text: JSON.stringify(value), shape: true }] : [{ name, text }];
  });
}

/** A row's value as the file holds it: a line, a list of its lines, or the value it kept. */
function written(pair: StatedPair): unknown {
  if (pair.shape === true) return JSON.parse(pair.text) as unknown;
  const lines = pair.text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 1 ? lines : pair.text.trim();
}

/** The rows as the map the file holds; a row with no name is not written, a later one wins. */
export function pairsRecord(pairs: readonly StatedPair[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const key = pair.name.trim();
    if (key.length > 0) out[key] = written(pair);
  }
  return out;
}

/** The rows a form sent, each a name and a text; anything else is dropped. */
export function asStatedPairs(value: unknown): StatedPair[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row): StatedPair[] => {
    if (!isRecord(row) || typeof row['name'] !== 'string' || typeof row['text'] !== 'string') {
      return [];
    }
    const pair = { name: row['name'], text: row['text'] };
    return [row['shape'] === true && keptValue(pair.text) ? { ...pair, shape: true } : pair];
  });
}

/** Whether a kept value's JSON still parses, so a save writes it back rather than throwing. */
function keptValue(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
