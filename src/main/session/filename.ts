/**
 * Filename fragments shared by the session records.
 *
 * `SessionLog` and `SessionCapture` name their files the same way — a sortable
 * local timestamp and a sanitised session label — and keeping the two
 * formatters in step by hand is how the names drift apart. One copy, imported
 * by both.
 */
import { clockOf, dayOf } from '../../shared/values';

/** What a session log's name ends in. */
export const LOG_SUFFIX = '.log';
/** What a capture's name ends in. */
export const CAPTURE_SUFFIX = '.mudcap.jsonl';

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
  return `${dayOf(at.getTime())}_${clockOf(at.getTime(), '-')}`;
}

/** `stamp`'s shape and the `_` after it. */
const STAMP = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_/;

/**
 * A name `SessionLog` or `SessionCapture` wrote: the stamp, a slug, a suffix.
 * The sweep deletes nothing else, since `logging.directory` may name a folder
 * that holds the player's own files too.
 */
export function isSessionRecord(name: string): boolean {
  const suffix = [LOG_SUFFIX, CAPTURE_SUFFIX].find((end) => name.endsWith(end));
  if (suffix === undefined) return false;
  const stem = name.slice(0, -suffix.length);
  const label = stem.replace(STAMP, '');
  return label !== stem && label.length > 0 && slug(label) === label;
}
