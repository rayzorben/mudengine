/**
 * The first line of a realm file: the header the graph's meta, its quests and
 * the catalogue's tables are all read out of.
 *
 * Parsed once, here, into a header whose format number (`v`) is checked, so
 * the meta and the catalogue's format gates read one number and cannot be
 * handed two (todo 711). See `mudengine-world` › *The catalogue is its own
 * unit*.
 */

/** A realm file's header: whatever it states, and the format number it always does. */
export type RealmHeader = Readonly<Record<string, unknown>> & { readonly v: number };

/** A header that states nothing — format 0, no tables: a realm with no file, or no header. */
export const NO_HEADER: RealmHeader = Object.freeze({ v: 0 });

/**
 * The first line of a realm file as its header, or null: parsed, an object,
 * and carrying the format number (`v`) every header has.
 */
export function headerOf(line: string): RealmHeader | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  return typeof record['v'] === 'number' ? (record as RealmHeader) : null;
}
