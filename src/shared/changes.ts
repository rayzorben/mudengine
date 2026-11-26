/**
 * What differs between two plain settings objects, as `path: before → after`.
 *
 * For the session's activity record: a setting changed from the settings
 * screen, from a file edited on disk or by a remote reaches the client as a
 * reloaded object, and this says which leaves moved. Arrays are compared and
 * shown whole; a leaf is shown clipped, so a long list does not fill a line.
 */
const SHOWN = 60;

function shown(value: unknown): string {
  const text =
    typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? 'undefined');
  return text.length > SHOWN ? `${text.slice(0, SHOWN)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every leaf that differs, in path order. */
export function changedPaths(before: unknown, after: unknown, path = ''): string[] {
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) =>
      changedPaths(before[key], after[key], path.length === 0 ? key : `${path}.${key}`)
    );
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [`${path}: ${shown(before)} → ${shown(after)}`];
}
