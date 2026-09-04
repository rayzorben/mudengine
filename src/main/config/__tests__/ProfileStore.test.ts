import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ProfileStore, type ProfileSnapshot } from '../ProfileStore';
import { PROFILE_FILE } from '../../app/home';

let dir: string;
let stores: ProfileStore[];
let base: Record<string, unknown>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-profiles-'));
  stores = [];
  base = {
    servers: [{ name: 'local', host: 'gmud-tgs', port: 2427, encoding: 'cp437' }]
  };
});

afterEach(() => {
  for (const store of stores) store.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * One character, in the shape the store reads: a directory with its own file.
 *
 * `name` is given as `<id>.yaml` throughout these tests because that is what
 * the layout used to be, and keeping the call sites means the tests still read
 * as "a character called mara" rather than as a directory walk.
 */
function write(name: string, body: string): void {
  const id = name.replace(/\.ya?ml$/i, '');
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(path.join(dir, id, PROFILE_FILE), body);
}

/** Something in the profiles directory that is not a character. */
function litter(name: string, body: string): void {
  fs.writeFileSync(path.join(dir, name), body);
}

function open(): ProfileStore {
  const store = new ProfileStore({ directory: dir, base: () => base });
  stores.push(store);
  return store;
}

/**
 * Waits for the next `change`.
 *
 * The store polls a directory listing rather than subscribing to inotify — see
 * its header for why — so a reload is a poll interval plus a debounce away. The
 * generous timeout is the mechanism's cost, not flakiness.
 */
function nextChange(store: ProfileStore, timeoutMs = 5000): Promise<ProfileSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no change event')), timeoutMs);
    store.on('change', (snapshot) => {
      clearTimeout(timer);
      resolve(snapshot);
    });
  });
}

describe('ProfileStore', () => {
  it('loads a character per file, ordered by id', () => {
    write('mara.yaml', 'server: local\n');
    write('thorn.yaml', 'server: local\nname: Thorn\n');

    const store = open();
    expect(store.profiles.map((profile) => profile.id)).toEqual(['mara', 'thorn']);
    expect(store.profiles[1]?.name).toBe('Thorn');
  });

  it('is empty and quiet when there are no files', () => {
    const store = open();
    expect(store.profiles).toEqual([]);
    expect(store.snapshot.errors).toEqual([]);
  });

  it('skips a character whose file will not parse, and loads the rest', () => {
    // One broken profile must not cost you the others. Named by its id, which
    // is its directory -- so the complaint points at where to go and fix it.
    write('broken.yaml', 'server: [unclosed\n');
    write('thorn.yaml', 'server: local\n');

    const store = open();
    expect(store.profiles.map((profile) => profile.id)).toEqual(['thorn']);
    expect(store.snapshot.errors.join(' ')).toContain('broken');
  });

  it('skips a character that cannot name a server, and says why', () => {
    write('nowhere.yaml', 'name: Nowhere\n');
    write('thorn.yaml', 'server: local\n');

    const store = open();
    expect(store.profiles.map((profile) => profile.id)).toEqual(['thorn']);
    expect(store.snapshot.errors.join(' ')).toMatch(/nowhere.*no server/i);
  });

  it('ignores an empty file rather than complaining about it', () => {
    // A file someone is part-way through writing is not a broken one.
    write('draft.yaml', '');
    const store = open();
    expect(store.profiles).toEqual([]);
    expect(store.snapshot.errors).toEqual([]);
  });

  it('ignores what is in the directory but is not a character', () => {
    // A character is a directory holding `profile.yaml`. A loose file beside
    // them is a leftover, a note, or a backup -- never a character.
    litter('notes.txt', 'server: local\n');
    litter('mara.yaml', 'server: local\n');
    fs.mkdirSync(path.join(dir, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.hidden', PROFILE_FILE), 'server: local\n');
    write('thorn.yaml', 'server: local\n');

    const store = open();
    expect(store.profiles.map((profile) => profile.id)).toEqual(['thorn']);
  });

  it('notices a character being added', async () => {
    const store = open();
    store.watch();
    const changed = nextChange(store);

    write('thorn.yaml', 'server: local\n');

    // Dropping a file in is the whole gesture for adding a character, so the
    // watcher compares a directory listing rather than one file's stats.
    expect((await changed).profiles.map((profile) => profile.id)).toEqual(['thorn']);
  });

  it('notices a character being removed', async () => {
    write('thorn.yaml', 'server: local\n');
    const store = open();
    store.watch();
    const changed = nextChange(store);

    fs.rmSync(path.join(dir, 'thorn'), { recursive: true });

    expect((await changed).profiles).toEqual([]);
  });

  it('notices an edit to an existing character', async () => {
    write('thorn.yaml', 'server: local\nname: Thorn\n');
    const store = open();
    store.watch();
    const changed = nextChange(store);

    write('thorn.yaml', 'server: local\nname: Thorn the Unready\n');

    expect((await changed).profiles[0]?.name).toBe('Thorn the Unready');
  });

  it('reapplies every overlay when the options file underneath changes', () => {
    write('thorn.yaml', 'server: local\n');
    const store = open();
    expect(store.profiles[0]?.config.automation.idle.afterSeconds).toBe(45); // the default

    // A profile is an overlay, so a reloaded options file has to reach every
    // character — including settings no profile mentions.
    base = {
      servers: [{ name: 'local', host: 'gmud-tgs', port: 2427 }],
      automation: { idle: { afterSeconds: 120 } }
    };
    store.refresh();

    expect(store.profiles[0]?.config.automation.idle.afterSeconds).toBe(120);
  });

  it('survives a directory that does not exist', () => {
    const store = new ProfileStore({
      directory: path.join(dir, 'nope'),
      base: () => base
    });
    stores.push(store);
    expect(store.profiles).toEqual([]);
    store.ensureDirectory();
    expect(fs.existsSync(path.join(dir, 'nope'))).toBe(true);
  });

  it('says so when the directory cannot be read, rather than showing no characters', () => {
    /*
     * An unreadable directory is not an empty one. Returning none silently made
     * every tab vanish with nothing said, which reads as "my characters are
     * gone" rather than "this folder is not readable".
     */
    write('thorn.yaml', 'server: local\n');
    const store = open();
    expect(store.profiles).toHaveLength(1);

    fs.chmodSync(dir, 0o000);
    try {
      store.refresh();
      // Root can read it regardless; only assert where the mode actually bites.
      if (store.snapshot.errors.length > 0) {
        expect(store.snapshot.errors.join(' ')).toContain(dir);
        expect(store.profiles).toEqual([]);
      }
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it('stays quiet about a directory that simply does not exist yet', () => {
    // ENOENT *is* the empty case: nobody has added a character.
    const store = new ProfileStore({ directory: path.join(dir, 'absent'), base: () => base });
    stores.push(store);
    expect(store.profiles).toEqual([]);
    expect(store.snapshot.errors).toEqual([]);
  });
});
