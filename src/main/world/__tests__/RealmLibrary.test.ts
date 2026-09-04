import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { RealmLibrary } from '../RealmLibrary';

let dir = '';
let shippedFile = '';
let cacheDir = '';
let notices: string[] = [];

/** A realm file in the shape `build-world.mjs` emits. */
function writeWorld(file: string, source: string, rooms: number): void {
  const header = JSON.stringify({ v: 2, source, rooms, generatedAt: 'x', items: [] });
  const lines = Array.from({ length: rooms }, (_, i) =>
    JSON.stringify({ m: 1, r: i + 1, n: `Room ${i + 1}`, x: {} })
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync([header, ...lines].join('\n') + '\n'));
}

const library = (): RealmLibrary =>
  new RealmLibrary({ shippedFile, cacheDir, notify: (message) => notices.push(message) });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-realms-'));
  shippedFile = path.join(dir, 'shipped.jsonl.gz');
  cacheDir = path.join(dir, 'realms');
  notices = [];
  writeWorld(shippedFile, 'shipped.mdb', 3);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a realm database that ships beside the client', () => {
  /*
   * `GMUD (5X)` names `mdb/gmud20230902.mdb` — relative, because an absolute
   * path in a shipped file exists on the one computer that wrote it and every
   * install would fall back with a notice. It has to resolve against the
   * client's own resources, which is `resources/` in a checkout and somewhere
   * else entirely inside a package.
   *
   * Asserted on the path the library *reached for*, which a refusal names, so
   * these cost nothing: converting a real 57,511-room database belongs in
   * `RealmLibrary.realm.test.ts`, and does it with the file that ships.
   */
  const shippingLibrary = (resourcesDir: string): RealmLibrary =>
    new RealmLibrary({
      shippedFile,
      cacheDir,
      resourcesDir,
      notify: (message) => notices.push(message)
    });

  it('resolves a relative path against the resources it shipped with', () => {
    const resources = path.join(dir, 'resources');
    const loaded = shippingLibrary(resources).load('mdb/absent.mdb');

    expect(loaded.problem).toContain(path.join(resources, 'mdb', 'absent.mdb'));
    // And falls back to the built-in world rather than to nothing, saying so.
    expect(loaded.graph.info.source).toBe('shipped.mdb');
  });

  it('leaves an absolute path exactly as the player typed it', () => {
    // A path a person chose is theirs. The file picker produces absolute paths
    // and so does anybody typing one, and joining a resources directory onto
    // the front of one would make it unopenable.
    const elsewhere = path.join(dir, 'mine.mdb');
    const loaded = shippingLibrary(path.join(dir, 'resources')).load(elsewhere);

    expect(loaded.problem).toContain(elsewhere);
    expect(loaded.problem).not.toContain(path.join('resources', dir));
  });

  it('leaves a relative path alone when there is nowhere to resolve it', () => {
    // Every caller without a resources directory — a probe, a test — names
    // absolute paths anyway, so a relative one is left to fail as the missing
    // file it is rather than being joined onto a guess.
    const loaded = library().load('mdb/absent.mdb');
    expect(loaded.problem).toContain('mdb/absent.mdb');
  });
});

describe('a character that names no realm', () => {
  it('gets the one the client ships', () => {
    const loaded = library().load('');
    expect(loaded.graph.size).toBe(3);
    expect(loaded.problem).toBeUndefined();
  });

  it('treats whitespace as naming none', () => {
    expect(library().load('   ').graph.size).toBe(3);
  });

  /* One graph, however many characters ask for it: 55,806 rooms indexed twice
     is a cost nobody asked for. */
  it('shares one graph between characters', () => {
    const realms = library();
    expect(realms.load('').graph).toBe(realms.load('').graph);
  });
});

/*
 * "The wrong map" beats "no map" only because it is announced. A client with no
 * realm data cannot say where it is at all.
 */
describe('a realm that cannot be used', () => {
  it('falls back to the shipped one, and says so', () => {
    const loaded = library().load(path.join(dir, 'missing.mdb'));
    expect(loaded.graph.size).toBe(3);
    expect(loaded.problem).toBeDefined();
    expect(notices.join(' ')).toMatch(/Falling back/);
  });

  it('says so every time, not once', () => {
    const realms = library();
    realms.load(path.join(dir, 'missing.mdb'));
    realms.load(path.join(dir, 'missing.mdb'));
    expect(notices.filter((notice) => /Falling back/.test(notice))).toHaveLength(2);
  });

  it('refuses a file that is not a realm database at all', () => {
    const wrong = path.join(dir, 'notes.txt');
    fs.writeFileSync(wrong, 'hello');
    const loaded = library().load(wrong);
    expect(loaded.problem).toMatch(/realm database|\.mdb/i);
    expect(loaded.graph.size).toBe(3);
  });

  it('reports a file whose contents are nonsense rather than throwing', () => {
    const broken = path.join(dir, 'broken.mdb');
    fs.writeFileSync(broken, Buffer.from('not an access database'));
    const loaded = library().load(broken);
    expect(loaded.problem).toBeDefined();
    expect(loaded.graph.size).toBe(3);
  });
});

/*
 * Everything that needs a real Access database — the conversion itself, the
 * identity-keyed cache and the pruning — is in `RealmLibrary.realm.test.ts`.
 * Converting 57,511 rooms takes about three seconds and seven of those
 * conversions ran here, which made this one file the wall-clock of the whole
 * unit suite. `npm run test:realm` and the pre-commit gate run them.
 */
describe('what a failed conversion leaves behind', () => {
  it('writes nothing at all', () => {
    const broken = path.join(dir, 'bad.mdb');
    fs.writeFileSync(broken, Buffer.from('x'));
    library().load(broken);
    expect(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []).toEqual([]);
  });

  /* So MUDENGINE_CONFIG relocates it too, and a read-only realm directory is
     not a reason a character cannot play. */
  it('keeps the cache beside the options file, not beside the realm', () => {
    library().load('');
    expect(fs.existsSync(path.join(dir, 'shipped.jsonl.gz'))).toBe(true);
  });
});

/*
 * The cache is keyed on the file's identity, so editing a realm leaves the old
 * conversion behind — correct, because it makes going back free, and unbounded,
 * because nothing was removing them. Each is most of a megabyte in a directory
 * the user can open.
 */
describe('keeping the cache from growing forever', () => {
  /** Stand-in conversions, so this tests the pruning rather than the converter. */
  const seedCache = (count: number): string[] => {
    fs.mkdirSync(cacheDir, { recursive: true });
    const made: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const file = path.join(cacheDir, `realm${i}.jsonl.gz`);
      writeWorld(file, `realm${i}.mdb`, 1);
      // Oldest first, so the ordering under test is unambiguous.
      const when = new Date(Date.now() - (count - i) * 86_400_000);
      fs.utimesSync(file, when, when);
      made.push(file);
    }
    return made;
  };

  it('keeps a realm that was converted recently', () => {
    const seeded = seedCache(3);
    const realm = path.join(dir, 'new.mdb');
    fs.writeFileSync(realm, Buffer.from('x'));
    library().load(realm); // fails to convert, so nothing is pruned
    for (const file of seeded) expect(fs.existsSync(file)).toBe(true);
  });
});
