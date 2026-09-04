/**
 * Filename fragments shared by the session records.
 *
 * `SessionLog` and `SessionCapture` name their files the same way — a sortable
 * local timestamp and a sanitised session label — and keeping the two
 * formatters in step by hand is how the names drift apart. One copy, imported
 * by both.
 */

/** Filesystem-safe fragment for a filename. */
export function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60);
}

/**
 * `YYYY-MM-DD_HH-MM-SS` in local time.
 *
 * Local rather than UTC because the only consumer is the person who was
 * playing, and sortable rather than locale-formatted because the only
 * navigation is an alphabetical file listing.
 */
export function stamp(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `_${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
  );
}
