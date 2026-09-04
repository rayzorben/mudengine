/**
 * The one spelling of "the visible directories inside this directory".
 *
 * Five stores and the migration each wrote out the same
 * `readdirSync(...).filter(isDirectory && !hidden).map(name).sort()` routine,
 * which is five places for the next decision about it — a new hidden prefix,
 * a sort rule — to be made in four of them. The predicate is policy, not
 * plumbing: a dot-prefixed directory is an editor's or a sync tool's, never a
 * character or a realm.
 *
 * Deliberately throws on an unreadable directory. Callers disagree about what
 * that means — ProfileStore's poll reads nothing quietly while its strict
 * listing surfaces the error — so the caller keeps its own catch policy
 * rather than this helper guessing one.
 */
import { readdirSync } from 'node:fs';

export function directoryNames(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}
