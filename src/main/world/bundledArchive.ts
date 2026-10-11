/**
 * Which bundled world a realm's database file is, decided once for the two
 * callers that need it: `RealmLibrary.load` at runtime and the todo 34
 * migration that files records by the world a realm loads. Two copies of
 * this would drift, and a migration that guesses differently from the load
 * files a realm's refills under a world it never walks.
 */

import fs from 'node:fs';
import path from 'node:path';

import { WorldGraph } from './WorldGraph';
import { identityOfArchive } from './buildRealm';
import {
  SHIPPED_WORLDS,
  shippedWorldFile,
  type ArchiveIdentity,
  type ShippedWorld
} from '../../shared/worlds';

/** Where one bundled world is kept. */
export function shippedWorldPath(shippedDir: string, world: ShippedWorld): string {
  return path.join(shippedDir, shippedWorldFile(world));
}

/** The archives the bundled worlds were built from, by world. A missing world is left out. */
export function shippedArchives(shippedDir: string): ReadonlyMap<ShippedWorld, ArchiveIdentity> {
  const archives = new Map<ShippedWorld, ArchiveIdentity>();
  for (const world of SHIPPED_WORLDS) {
    const archive = WorldGraph.meta(shippedWorldPath(shippedDir, world))?.archive;
    if (archive) archives.set(world, archive);
  }
  return archives;
}

/**
 * The bundled world `file` is the very archive of, or null. By content, never
 * by name: the size first (a `stat`), the SHA-1 only when a size agrees, so a
 * private realm costs no read. Throws when the file cannot be read.
 */
export function archiveWorldOf(
  file: string,
  archives: ReadonlyMap<ShippedWorld, ArchiveIdentity>
): ShippedWorld | null {
  const size = fs.statSync(file).size;
  const candidates = [...archives].filter(([, archive]) => archive.size === size);
  if (candidates.length === 0) return null;
  const sha1 = identityOfArchive(file).sha1;
  return candidates.find(([, archive]) => archive.sha1 === sha1)?.[0] ?? null;
}

/**
 * A realm's `database:` as a path. A relative one can only have come from a
 * file this client ships, so it resolves against the resources directory; an
 * absolute one is the player's and is used as given. Without a resources
 * directory a relative path is left alone, to fail as the missing file it is.
 */
export function databasePath(database: string, resourcesDir: string | undefined): string {
  if (database.length === 0 || resourcesDir === undefined || path.isAbsolute(database)) {
    return database;
  }
  return path.join(resourcesDir, database);
}
