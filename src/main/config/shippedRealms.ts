/**
 * Puts the realms the client ships into the home, so a fresh client has
 * somewhere to play rather than an empty Realms page (`mudengine-config` ›
 * *A server is a directory*).
 *
 * File by file through `createYaml`, so a crash part way leaves whole files
 * and missing ones, and the next start copies what is missing. `.shipped`
 * is written last and lists each realm offered: a listed realm the player
 * removed by hand stays removed, and a realm a later release ships is copied
 * on the start after the update. A realm removed from the Realms page stays
 * removed too, since that leaves its `server.yaml.bak` behind, and a shipped
 * realm whose name another realm here already has is not copied.
 */
import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';

import { errorMessage } from '../../shared/values';
import { createYaml } from './YamlFile';
import { SERVER_FILE } from '../app/home';
import { writeWholeSync } from '../app/writeWhole';

/** The file listing every shipped realm offered once, one id a line. */
const DONE = '.shipped';

/**
 * What a `.shipped` written before it listed ids offered: the six Paradigm
 * realms, which were every realm shipped then (2026-11-04). Read only from a
 * file naming no id, and the file is rewritten with ids on that start.
 */
const SHIPPED_BEFORE_IDS = [
  'paradigm-game-1-pve',
  'paradigm-game-2-pvp',
  'paradigm-game-3',
  'paradigm-game-4',
  'paradigm-test-pve',
  'paradigm-test-pvp'
];

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
  if (!fs.existsSync(shipped)) return { written: [], error: null };
  const done = path.join(serversDir, DONE);
  const written = new Set<string>();
  try {
    const offered = offeredBefore(done);
    const ids = fs
      .readdirSync(shipped, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    if (ids.every((id) => offered.has(id))) return { written: [], error: null };
    const taken = namesHere(serversDir);
    for (const relative of filesUnder(shipped)) {
      const id = relative.split(path.sep)[0] ?? relative;
      if (offered.has(id)) continue;
      const target = path.join(serversDir, relative);
      if (fs.existsSync(target) || removed(path.join(serversDir, id))) continue;
      // Two realms may not share a name: one the player made under another id keeps it.
      const source = path.join(shipped, relative);
      const text = fs.readFileSync(source, 'utf8');
      const name = path.basename(relative) === SERVER_FILE ? nameOf(text) : null;
      const holder = name === null ? undefined : taken.get(name.toLowerCase());
      if (holder !== undefined && holder !== id) continue;
      const made = createYaml(target, text);
      if (!made.ok) return { written: [...written].sort(), error: made.error };
      written.add(id);
    }
    writeWholeSync(
      done,
      `# Every shipped realm offered once, by id. One listed here is never copied again.\n${[
        ...new Set([...offered, ...ids])
      ]
        .sort()
        .join('\n')}\n`
    );
  } catch (error) {
    return { written: [...written].sort(), error: errorMessage(error) };
  }
  return { written: [...written].sort(), error: null };
}

/** The ids `.shipped` lists; none when it is absent, the first six when it names none. */
function offeredBefore(done: string): Set<string> {
  if (!fs.existsSync(done)) return new Set();
  const ids = fs
    .readFileSync(done, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  return new Set(ids.length > 0 ? ids : SHIPPED_BEFORE_IDS);
}

/** Each realm's name here, lower-cased, to the id it is under. */
function namesHere(serversDir: string): Map<string, string> {
  const names = new Map<string, string>();
  if (!fs.existsSync(serversDir)) return names;
  for (const entry of fs.readdirSync(serversDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(serversDir, entry.name, SERVER_FILE);
    if (!fs.existsSync(file)) continue;
    const name = nameOf(fs.readFileSync(file, 'utf8'));
    if (name !== null) names.set(name.toLowerCase(), entry.name);
  }
  return names;
}

/** A realm file's `name:`, or null when it states none or does not parse. */
function nameOf(text: string): string | null {
  try {
    const parsed: unknown = parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const name = (parsed as Record<string, unknown>)['name'];
    return typeof name === 'string' && name.trim().length > 0 ? name.trim() : null;
  } catch {
    return null;
  }
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
