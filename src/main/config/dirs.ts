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
import { readdirSync, type Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';

export function directoryNames(dir: string): string[] {
  return visible(readdirSync(dir, { withFileTypes: true }));
}

/** The same listing without holding the thread (`revision.ts`'s poll). */
export async function directoryNamesLater(dir: string): Promise<string[]> {
  return visible(await readdir(dir, { withFileTypes: true }));
}

function visible(entries: Dirent[]): string[] {
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}
