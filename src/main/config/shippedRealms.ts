/**
 * Puts the realms the client ships into the home, so a fresh client has
 * somewhere to play rather than an empty Realms page (`mudengine-config` ›
 * *A server is a directory*).
 *
 * File by file through `createYaml`, so a crash part way leaves whole files
 * and missing ones, and the next start copies what is missing. `.shipped`
 * is written last and ends it: after that, a realm the player removed by
 * hand stays removed. Before it, a realm removed from the Realms page stays
 * removed too, file and all, since that leaves its `server.yaml.bak` behind.
 */
import fs from 'node:fs';
import path from 'node:path';

import { errorMessage } from '../../shared/values';
import { createYaml } from './YamlFile';
import { SERVER_FILE } from '../app/home';
import { writeWholeSync } from '../app/writeWhole';

/** The file that says every shipped realm has been copied in once. */
const DONE = '.shipped';

export interface SeedResult {
  /** The realms a file was copied into, by directory name, sorted. */
  written: string[];
  /** What could not be copied, said by the caller; the next start tries again. */
  error: string | null;
}

export function seedServers({
  shipped,
  serversDir
}: {
  shipped: string;
  serversDir: string;
}): SeedResult {
  const done = path.join(serversDir, DONE);
  if (fs.existsSync(done) || !fs.existsSync(shipped)) return { written: [], error: null };
  const written = new Set<string>();
  try {
    for (const relative of filesUnder(shipped)) {
      const id = relative.split(path.sep)[0] ?? relative;
      const target = path.join(serversDir, relative);
      if (fs.existsSync(target) || removed(path.join(serversDir, id))) continue;
      const made = createYaml(target, fs.readFileSync(path.join(shipped, relative), 'utf8'));
      if (!made.ok) return { written: [...written].sort(), error: made.error };
      written.add(id);
    }
    writeWholeSync(done, '# Every shipped realm has been copied in once.\n');
  } catch (error) {
    return { written: [...written].sort(), error: errorMessage(error) };
  }
  return { written: [...written].sort(), error: null };
}

/** A realm deleted from the Realms page, which keeps its file's backup and its loops. */
function removed(realm: string): boolean {
  const file = path.join(realm, SERVER_FILE);
  // A save leaves the backup too; only a deleted realm has it without the file.
  return fs.existsSync(`${file}.bak`) && !fs.existsSync(file);
}

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));
}
