import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openRealm, realmKind, REALM_EXTENSIONS } from '../RealmSource';
import { archiveOf, written } from './zipWriter';

/**
 * What `openRealm` accepts, and what it refuses out loud.
 *
 * The realm a player names is untrusted input, and every failure here has the
 * same worst case: a realm that reads as empty is a client that plans routes
 * against nothing while saying it loaded a map. So the interesting assertions
 * are the messages — each one has to name the file and say what to do next.
 */
const isCorrupt = /realm database|not a realm|holds no|holds \d/i;

describe('choosing a reader', () => {
  it('offers exactly the extensions it can open', () => {
    // The two halves of a closed union: the picker's list and the reader's
    // answer. A dialog offering a file the reader refuses is a file a player
    // can choose and cannot use.
    for (const extension of REALM_EXTENSIONS) {
      const file = `/x/realm.${extension}`;
      expect(realmKind(file) !== null || extension === 'zip').toBe(true);
    }
  });

  it('says a missing file is missing, not that it is the wrong shape', () => {
    expect(() => openRealm('/x/nowhere/realm.mdb')).toThrow(/No realm database at/);
    expect(() => openRealm('/x/nowhere/realm.zip')).toThrow(/No realm database at/);
  });

  it('refuses a file that is not a realm, naming the shapes that are', () => {
    const file = written(Buffer.from('hello'), 'notes.txt');
    expect(() => openRealm(file)).toThrow(/not a realm database.*\.zip/s);
  });
});

/*
 * An archive is a container, so the question it raises is *which file inside*,
 * and the only safe answers are "the one" and "no". The newer one, the bigger
 * one and the one whose name looks right are three different guesses, and the
 * wrong one is a map that is confidently somewhere else.
 */
describe('a realm inside an archive', () => {
  it('reads the one database it holds, and reports the archive as its path', () => {
    const file = written(archiveOf([{ name: 'realm.mdb', body: Buffer.alloc(2048, 1) }]));
    const source = openRealm(file);
    expect(source.kind).toBe('mdb');
    // The archive, not the entry: what a realm was built from is what a
    // message names and what the conversion cache is keyed on.
    expect(source.path).toBe(file);
    source.close();
  });

  it('opens without reading: a realm nobody asks about is one nobody unpacks', () => {
    // 2 KB of nothing is not an Access database, and opening it is still fine —
    // the bytes are only fetched when a table is asked for.
    const file = written(archiveOf([{ name: 'realm.mdb', body: Buffer.alloc(2048, 1) }]));
    const source = openRealm(file);
    expect(() => source.tableNames()).toThrow();
    source.close();
  });

  it('refuses an archive holding no database, and says what it does hold', () => {
    const file = written(
      archiveOf([
        { name: 'readme.txt', body: Buffer.from('unzip me'), stored: true },
        { name: 'realm.doc', body: Buffer.from('x'), stored: true }
      ])
    );
    expect(() => openRealm(file)).toThrow(/holds no realm database.*readme\.txt, realm\.doc/s);
  });

  it('refuses an empty archive as empty rather than as ambiguous', () => {
    expect(() => openRealm(written(archiveOf([])))).toThrow(/it is empty/);
  });

  it('refuses to choose between two databases, and names both', () => {
    const file = written(
      archiveOf([
        { name: 'old.mdb', body: Buffer.alloc(64, 1), stored: true },
        { name: 'new.mdb', body: Buffer.alloc(64, 2), stored: true }
      ])
    );
    expect(() => openRealm(file)).toThrow(/holds 2 realm databases \(old\.mdb, new\.mdb\)/);
    expect(() => openRealm(file)).toThrow(/Unzip it and name the one you want/);
  });

  it('does not count a zero-byte entry as the database it holds', () => {
    // Otherwise "holds no database" becomes "holds two", and the message sends
    // somebody looking for a file that has nothing in it.
    const file = written(
      archiveOf([
        { name: 'empty.mdb', body: Buffer.alloc(0), stored: true },
        { name: 'notes.txt', body: Buffer.from('x'), stored: true }
      ])
    );
    expect(() => openRealm(file)).toThrow(isCorrupt);
  });
});

/** Is `sqlite3` on this machine? The reader needs it, and says so if not. */
function hasSqlite(): boolean {
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/*
 * The one shape that cannot be read out of memory: the SQLite reader shells out
 * to a CLI, deliberately, and a CLI needs a path. So the entry is unpacked to a
 * temporary file — and the thing worth testing is that the file goes away
 * again, because a client that converts a realm per launch would otherwise
 * leave a copy of every one of them in `/tmp` for ever.
 *
 * Skipped where `sqlite3` is not installed, which is the same accommodation
 * `SqliteSource` itself documents — an `.mdb` needs nothing.
 */
describe.skipIf(!hasSqlite())('a SQLite realm inside an archive', () => {
  function sqliteBytes(): Buffer {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-sqlite-'));
    const file = path.join(dir, 'realm.sqlite');
    execFileSync('sqlite3', [file, 'CREATE TABLE Rooms (id INTEGER, name TEXT);'], {
      stdio: 'ignore'
    });
    execFileSync('sqlite3', [file, "INSERT INTO Rooms VALUES (1, 'Newhaven, Town Square');"], {
      stdio: 'ignore'
    });
    const bytes = fs.readFileSync(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return bytes;
  }

  const temporaries = (): string[] =>
    fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('mudengine-realm-'));

  it('reads it through the CLI, then removes what it unpacked', () => {
    const file = written(archiveOf([{ name: 'realm.sqlite', body: sqliteBytes() }]));
    const before = temporaries();
    const source = openRealm(file);
    try {
      expect(source.tableNames()).toContain('Rooms');
      expect(source.table('rooms')?.rows[0]?.['name']).toBe('Newhaven, Town Square');
      // The positive control: something really was written, so the assertion
      // after `close()` is about cleanup rather than about nothing happening.
      expect(temporaries().length).toBe(before.length + 1);
    } finally {
      source.close();
    }
    expect(temporaries()).toEqual(before);
  });

  it('can be closed twice, like every other source', () => {
    const file = written(archiveOf([{ name: 'realm.sqlite', body: sqliteBytes() }]));
    const source = openRealm(file);
    source.close();
    expect(() => source.close()).not.toThrow();
  });
});
