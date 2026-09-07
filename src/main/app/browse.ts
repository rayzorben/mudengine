/**
 * A directory under the client's home, listed for a window to show.
 *
 * The desktop client reveals a path by opening the operating system's file
 * manager on it. A browser tab cannot: the files are on the machine the
 * client runs on, which is not the machine the tab is on. So the tab is shown
 * a listing instead — names, kinds and sizes, and never contents, because the
 * options file and every profile in this tree hold the player's realm
 * password and a listing that served bytes would serve that.
 *
 * **Confined to the home root, by resolved path.** A listing endpoint is a
 * traversal surface: `..`, an absolute path, a symlink out of the tree. Every
 * request is resolved to its real path and refused unless it is the root or
 * under it — refused with a reason, never quietly answered with something
 * else, which is the rule `asRoute` keeps for the other payload that turns
 * into something on this machine.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import type { DirectoryEntry, HomeListing } from '../../shared/ipc';
import { errorMessage } from '../../shared/values';

export interface BrowseWording {
  /** The path resolved outside the home. */
  outside(): string;
  /** The path could not be read. */
  unreadable(target: string, message: string): string;
}

/**
 * Whether one real path is the other or inside it. String arithmetic on
 * resolved paths, with the separator appended so `/home/a` does not contain
 * `/home/ab`.
 */
export function isWithin(root: string, candidate: string): boolean {
  return (
    candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  );
}

export async function listHome(
  root: string,
  target: string | null,
  isRealm: (name: string) => boolean,
  wording: BrowseWording
): Promise<HomeListing> {
  const refused = (dir: string, error: string): HomeListing => ({
    root,
    dir,
    parent: null,
    selected: null,
    entries: [],
    error
  });

  let rootReal: string;
  try {
    rootReal = await fs.realpath(root);
  } catch (error) {
    return refused(root, wording.unreadable(root, errorMessage(error)));
  }

  const asked =
    target === null || target.trim().length === 0 ? rootReal : path.resolve(rootReal, target);
  /*
   * Refused on the *stated* path before the filesystem is asked anything.
   * Resolving first would answer a path outside the root with "does not
   * exist" or "could not be read" — a message that says, one path at a time,
   * what is on the machine beyond the home. The root as given is accepted
   * beside its real path, because a client whose home sits under a symlink
   * states its own paths in the spelling it was configured with.
   */
  if (!isWithin(path.resolve(root), asked) && !isWithin(rootReal, asked)) {
    return refused(asked, wording.outside());
  }
  let real: string;
  try {
    real = await fs.realpath(asked);
  } catch (error) {
    return refused(asked, wording.unreadable(asked, errorMessage(error)));
  }
  if (!isWithin(rootReal, real)) return refused(asked, wording.outside());

  let dir = real;
  let selected: string | null = null;
  try {
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) {
      dir = path.dirname(real);
      selected = path.basename(real);
    }
  } catch (error) {
    return refused(real, wording.unreadable(real, errorMessage(error)));
  }
  // A file directly under a symlinked root resolves to a directory the root's
  // real path contains, so this holds; checked again because it is cheap and
  // the failure it guards is the whole point of the module.
  if (!isWithin(rootReal, dir)) return refused(dir, wording.outside());

  let names: import('node:fs').Dirent[];
  try {
    names = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    return refused(dir, wording.unreadable(dir, errorMessage(error)));
  }

  const entries: DirectoryEntry[] = [];
  for (const entry of names) {
    const full = path.join(dir, entry.name);
    let size: number | null = null;
    let kind: DirectoryEntry['kind'] = 'other';
    try {
      // `stat`, not `lstat`: a symlink is shown as what it points at, and one
      // pointing outside the root lists as a name here and is refused when
      // followed — by the resolution above, on the next request.
      const stat = await fs.stat(full);
      kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
      size = stat.isFile() ? stat.size : null;
    } catch {
      // A dangling link or a race with a delete: listed by name, sized as unknown.
    }
    entries.push({
      name: entry.name,
      kind,
      size,
      realm: kind === 'file' && isRealm(entry.name)
    });
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : b.kind === 'directory' ? 1 : 0;
    return a.name.localeCompare(b.name);
  });

  return {
    root: rootReal,
    dir,
    parent: dir === rootReal ? null : path.dirname(dir),
    selected,
    entries,
    error: null
  };
}
