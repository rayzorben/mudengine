/**
 * One character, with the realm it plays on and its own records, as one file.
 *
 * The file mirrors the home's own tree (`profiles/<id>/`, `servers/<id>/`,
 * `memory/<id>.json`, …) beside a manifest, so it can also be unpacked by
 * hand. Import writes nothing that is already there: a taken character id gets
 * a free one, and a realm of the same name is used as it is.
 * `mudengine-config` › *A character travels as one file* has the reasons.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse, parseDocument } from 'yaml';

import { asServer } from '../../shared/config';
import { asProfileId } from '../../shared/drafts';
import { fileSlug, isLoopFileName } from '../../shared/files';
import type { CharacterImport } from '../../shared/ipc';
import { errorMessage, isRecord } from '../../shared/values';
import { asShippedWorld } from '../../shared/worlds';
import {
  CHARACTER_RECORD_KINDS,
  CHARACTER_RECORDS,
  recordPath,
  type CharacterRecord,
  type Home
} from '../app/home';
import { t } from '../app/i18n';
import { ServerStore } from './ServerStore';
import { packTarball, unpackTarball, type TarEntry } from './tarball';

const MANIFEST = 'mudengine-character.json';
const FORMAT = 'mudengine-character';

interface Manifest {
  format: typeof FORMAT;
  character: string;
  realm: string | null;
}

export type Exported = { ok: true; bytes: Buffer; name: string } | { ok: false; error: string };

/**
 * The character's file, its loops, its realm's file and loops, and each of its
 * records that exists. The account password is taken out of the copy unless
 * `password` asks for it.
 */
export async function exportCharacter(
  home: Home,
  id: string,
  password: boolean
): Promise<Exported> {
  const scope = home.profile(id);
  if (!fs.existsSync(scope.file)) return { ok: false, error: t('app.profiles.noSuchCharacter') };

  const document = parseDocument(await fs.promises.readFile(scope.file, 'utf8'));
  if (document.errors.length > 0) {
    return { ok: false, error: t('app.transfer.unreadable', { file: scope.file }) };
  }
  if (!password) document.deleteIn(['account', 'password']);
  const name = stringAt(document.get('name')) ?? id;
  const realmName = stringAt(document.get('server'));
  const realm = realmName === null ? undefined : new ServerStore(home).idFor(realmName);

  const entries: TarEntry[] = [
    { name: `profiles/${id}/profile.yaml`, data: Buffer.from(document.toString(), 'utf8') },
    ...(await filesIn(scope.loops, `profiles/${id}/loops`, isLoopFile))
  ];
  if (realm !== undefined) {
    const server = home.server(realm);
    entries.push(
      { name: `servers/${realm}/server.yaml`, data: await fs.promises.readFile(server.file) },
      ...(await filesIn(server.loops, `servers/${realm}/loops`, isLoopFile))
    );
  }
  for (const kind of CHARACTER_RECORD_KINDS) entries.push(...(await recordEntries(home, kind, id)));
  const manifest: Manifest = { format: FORMAT, character: id, realm: realm ?? null };
  entries.unshift({ name: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2)) });
  return { ok: true, bytes: await packTarball(entries), name };
}

/**
 * Writes an exported character into this home. `taken` names the character ids
 * something here already uses beyond what is on disk (a loaded tab).
 */
export async function importCharacter(
  home: Home,
  bytes: Buffer,
  options: { maxBytes: number; taken(id: string): boolean }
): Promise<CharacterImport> {
  const entries = await unpackTarball(bytes, options.maxBytes);
  const manifest = entries === null ? null : asManifest(entries);
  if (entries === null || manifest === null) {
    return { kind: 'refused', error: t('app.transfer.notACharacter') };
  }
  const files = placeEntries(entries, manifest);
  const profile = files?.get(`profiles/${manifest.character}/profile.yaml`);
  if (files === null || files === undefined || profile === undefined) {
    return { kind: 'refused', error: t('app.transfer.notACharacter') };
  }

  const notes: string[] = [];
  const taken = {
    has: (id: string) =>
      options.taken(id) ||
      fs.existsSync(home.profile(id).dir) ||
      CHARACTER_RECORD_KINDS.some((kind) => fs.existsSync(home.record(kind, id)))
  };
  const id = taken.has(manifest.character)
    ? fileSlug(manifest.character, taken)
    : manifest.character;
  const profileFile = parse(profile.toString('utf8')) as unknown;
  const name = (isRecord(profileFile) ? stringAt(profileFile['name']) : null) ?? id;
  if (id !== manifest.character) notes.push(t('app.transfer.renamed', { name, id }));
  if (isRecord(profileFile) && wantsPassword(profileFile)) {
    notes.push(t('app.transfer.noPassword'));
  }

  const writes: Array<{ file: string; data: Buffer }> = [];
  const realm = placeRealm(home, manifest, files, notes);
  const realmName = isRecord(profileFile) ? stringAt(profileFile['server']) : null;
  if (
    realm === null &&
    realmName !== null &&
    new ServerStore(home).idFor(realmName) === undefined
  ) {
    notes.push(t('app.transfer.noRealm', { realm: realmName }));
  }
  if (realm !== null) {
    writes.push(...filesUnder(files, `servers/${manifest.realm}/`, home.server(realm).dir));
  }
  for (const kind of CHARACTER_RECORD_KINDS) {
    const inside = recordPath(kind, manifest.character);
    if (isDirectory(kind)) {
      writes.push(...filesUnder(files, `${inside}/`, home.record(kind, id)));
      continue;
    }
    const data = files.get(inside);
    if (data !== undefined) writes.push({ file: home.record(kind, id), data });
  }
  writes.push(
    ...filesUnder(files, `profiles/${manifest.character}/loops/`, home.profile(id).loops)
  );
  // Last, because the character appearing is what loads it, and everything
  // it reads has to be there first.
  writes.push({ file: home.profile(id).file, data: profile });

  const error = await writeAll(writes);
  return error === null ? { kind: 'imported', id, name, notes } : { kind: 'refused', error };
}

/** Each file under `prefix` in the export, placed under `dir` here. */
function filesUnder(
  files: ReadonlyMap<string, Buffer>,
  prefix: string,
  dir: string
): Array<{ file: string; data: Buffer }> {
  return [...files]
    .filter(([inside]) => inside.startsWith(prefix))
    .map(([inside, data]) => ({ file: path.join(dir, inside.slice(prefix.length)), data }));
}

/** The realm directory to write the bundled realm into, or null to write none. */
function placeRealm(
  home: Home,
  manifest: Manifest,
  files: ReadonlyMap<string, Buffer>,
  notes: string[]
): string | null {
  const bundled =
    manifest.realm === null ? undefined : files.get(`servers/${manifest.realm}/server.yaml`);
  if (manifest.realm === null || bundled === undefined) return null;
  const server = asServer(parse(bundled.toString('utf8')), manifest.realm);
  if (server === null) return null;
  const store = new ServerStore(home);
  if (store.idFor(server.name) !== undefined) {
    notes.push(t('app.transfer.realmKept', { realm: server.name }));
    return null;
  }
  const database = server.database.trim();
  if (database.length > 0 && asShippedWorld(database) === null && !fs.existsSync(database)) {
    notes.push(t('app.transfer.databaseMissing', { realm: server.name, database }));
  }
  const ids = new Set(store.all.map((entry) => entry.id));
  const taken = { has: (id: string) => ids.has(id) || fs.existsSync(home.server(id).dir) };
  notes.push(t('app.transfer.realmAdded', { realm: server.name }));
  return taken.has(manifest.realm) ? fileSlug(manifest.realm, taken) : manifest.realm;
}

/**
 * Each entry keyed by its path in the file, or null when one is anything but
 * the shapes the export writes. Refused whole rather than filtered, because a
 * file with something else in it is not one this client wrote.
 */
function placeEntries(
  entries: readonly TarEntry[],
  manifest: Manifest
): Map<string, Buffer> | null {
  const own = manifest.character;
  const allowed = new Set<string>([
    MANIFEST,
    `profiles/${own}/profile.yaml`,
    ...CHARACTER_RECORD_KINDS.filter((kind) => !isDirectory(kind)).map((kind) =>
      recordPath(kind, own)
    ),
    ...(manifest.realm === null ? [] : [`servers/${manifest.realm}/server.yaml`])
  ]);
  const dirs: Array<{ dir: string; holds(name: string): boolean }> = [
    { dir: `profiles/${own}/loops/`, holds: isLoopFile },
    ...(manifest.realm === null
      ? []
      : [{ dir: `servers/${manifest.realm}/loops/`, holds: isLoopFile }]),
    ...CHARACTER_RECORD_KINDS.filter(isDirectory).map((kind) => ({
      dir: `${recordPath(kind, own)}/`,
      holds: isRecordFile
    }))
  ];
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    const inDir = dirs.some(
      ({ dir, holds }) => entry.name.startsWith(dir) && holds(entry.name.slice(dir.length))
    );
    if (!allowed.has(entry.name) && !inDir) return null;
    if (entry.name !== MANIFEST) files.set(entry.name, entry.data);
  }
  return files;
}

/** A loop file directly inside its directory: no separator can climb out. */
function isLoopFile(name: string): boolean {
  return isLoopFileName(name) && !/[/\\]/.test(name);
}

/**
 * A file directly inside a record that is a directory. A leading dot is a
 * file being written (`fightSegments.isPendingFold`), never part of the record.
 */
function isRecordFile(name: string): boolean {
  return name.length > 0 && !name.startsWith('.') && !/[/\\]/.test(name);
}

function isDirectory(kind: CharacterRecord): boolean {
  return CHARACTER_RECORDS[kind].holds === 'directory';
}

/** One record as entries: its file, or each file directly inside its directory. */
async function recordEntries(home: Home, kind: CharacterRecord, id: string): Promise<TarEntry[]> {
  const at = home.record(kind, id);
  if (isDirectory(kind)) return filesIn(at, recordPath(kind, id), isRecordFile);
  if (!fs.existsSync(at)) return [];
  return [{ name: recordPath(kind, id), data: await fs.promises.readFile(at) }];
}

function asManifest(entries: readonly TarEntry[]): Manifest | null {
  const raw = entries.find((entry) => entry.name === MANIFEST);
  if (raw === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw.data.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(value) || value['format'] !== FORMAT) return null;
  const character = asProfileId(value['character']);
  const realm = value['realm'] === null ? null : asProfileId(value['realm']);
  if (character === null || (value['realm'] !== null && realm === null)) return null;
  return { format: FORMAT, character, realm };
}

/**
 * Creates each file, refusing one that exists (`wx`). On a failure the files
 * and directories this call created are removed again, so a half-imported
 * character never appears and a retry is not taken for a second one.
 */
async function writeAll(
  writes: ReadonlyArray<{ file: string; data: Buffer }>
): Promise<string | null> {
  const files: string[] = [];
  const dirs: string[] = [];
  try {
    for (const { file, data } of writes) {
      const dir = path.dirname(file);
      const made = await fs.promises.mkdir(dir, { recursive: true });
      if (made !== undefined) dirs.push(...createdBetween(made, dir));
      await fs.promises.writeFile(file, data, { flag: 'wx' });
      files.push(file);
    }
    return null;
  } catch (error) {
    const left: string[] = [];
    for (const file of files) {
      await fs.promises.unlink(file).catch(() => left.push(file));
    }
    // Deepest first; `rmdir` removes only an empty one, so nothing else goes.
    for (const dir of dirs.sort((a, b) => b.length - a.length)) {
      await fs.promises.rmdir(dir).catch(() => left.push(dir));
    }
    return t('app.transfer.writeFailed', {
      message: errorMessage(error),
      left: left.length > 0 ? left.join(', ') : t('app.transfer.nothingLeft')
    });
  }
}

/** `made` and each directory under it down to `dir`: what one `mkdir -p` created. */
function createdBetween(made: string, dir: string): string[] {
  const created = [made];
  for (let at = dir; at !== made && at.length > made.length; at = path.dirname(at)) {
    created.push(at);
  }
  return created;
}

/** Each regular file directly inside `dir` that `accept` takes, named under `inside`. */
async function filesIn(
  dir: string,
  inside: string,
  accept: (name: string) => boolean
): Promise<TarEntry[]> {
  let names: string[];
  try {
    names = (await fs.promises.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && accept(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  return Promise.all(
    names.map(async (name) => ({
      name: `${inside}/${name}`,
      data: await fs.promises.readFile(path.join(dir, name))
    }))
  );
}

/** An account is stated and its password is not: the player types it once. */
function wantsPassword(profile: Record<string, unknown>): boolean {
  const account = profile['account'];
  return isRecord(account) && stringAt(account['password']) === null;
}

function stringAt(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
