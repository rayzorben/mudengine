/**
 * `RealmLibrary` against a real Access database.
 *
 * Split out of `RealmLibrary.test.ts` because these are the only tests in the
 * unit suite that do a minute of real work: converting 57,511 rooms takes
 * about three seconds, seven conversions ran on every `npm test`, and this one
 * file set the wall-clock of the whole suite. They are **not** optional — the
 * whole point of this path is reading a real database, and a fixture would
 * prove the caching and nothing about the thing being cached — so they run in
 * `npm run test:realm` and in the pre-commit gate, and are excluded from the
 * iteration loop only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { RealmLibrary } from '../RealmLibrary';

/**
 * The realm the repository ships, so this runs on any checkout.
 *
 * It named one developer's Dropbox until 2026-08-27, which meant the
 * conversion path was covered on exactly one computer and silently skipped
 * everywhere else — including CI, where a skipped test and a passing one read
 * the same. `MUDENGINE_TEST_MDB` points it at another realm.
 *
 * **And the name is a dependency, which the skip hides.** The Paradigm realm
 * was renamed `default-pmud.mdb` on 2026-09-02 and this went on saying
 * `data-Paradigm-1.9-TEST.mdb`, so `npm run gate` printed *All checks passed*
 * with all six of these skipped — the exact failure the paragraph above is
 * about, from the other direction. A missing file is a legitimate reason to
 * skip on somebody else's checkout and a silent hole on the one that has it,
 * and nothing distinguishes the two. Whoever renames it next has to come here.
 */
const REAL_MDB = process.env['MUDENGINE_TEST_MDB'] ?? path.resolve('mdb/default-pmud.mdb');

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

/*
 * The cache is keyed on what the file *is*, not where it lives. A cache keyed
 * on the path alone goes stale in silence, which here means planning routes
 * against a realm that has changed underneath you.
 *
 * Skipped where no realm database is present, so the suite still runs on a
 * checkout that has never seen one.
 */
const withRealm = fs.existsSync(REAL_MDB) ? describe : describe.skip;

withRealm('converting a realm somebody chose', () => {
  it('reads it, and uses it instead of the shipped one', () => {
    const loaded = library().load(REAL_MDB);
    expect(loaded.problem).toBeUndefined();
    // Not the three-room fixture: this is the real realm.
    expect(loaded.graph.size).toBeGreaterThan(50_000);
    expect(loaded.source).toContain('.mdb');
  }, 120_000);

  it('converts once and reads the cache after that', () => {
    library().load(REAL_MDB);
    expect(notices.filter((notice) => /Converting/.test(notice))).toHaveLength(1);

    // A second library, as a second launch would be: the cache is on disk.
    notices = [];
    const loaded = library().load(REAL_MDB);
    expect(loaded.graph.size).toBeGreaterThan(50_000);
    expect(notices.filter((notice) => /Converting/.test(notice))).toHaveLength(0);
  }, 120_000);

  it('hands the same graph to two characters on one realm', () => {
    const realms = library();
    expect(realms.load(REAL_MDB).graph).toBe(realms.load(REAL_MDB).graph);
  }, 120_000);

  /*
   * Keyed on identity, so editing the realm reconverts. A cache keyed on the
   * path alone would keep routing against a realm that had changed.
   */
  it('reconverts when the file changes underneath it', () => {
    const copy = path.join(dir, 'realm.mdb');
    fs.copyFileSync(REAL_MDB, copy);
    library().load(copy);
    expect(fs.readdirSync(cacheDir)).toHaveLength(1);

    // Same bytes, new modification time: a different thing as far as a cache
    // that cannot afford to be stale is concerned.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(copy, later, later);
    notices = [];
    library().load(copy);
    expect(notices.filter((notice) => /Converting/.test(notice))).toHaveLength(1);
    expect(fs.readdirSync(cacheDir)).toHaveLength(2);
  }, 180_000);

  it('leaves no half-written cache behind', () => {
    library().load(REAL_MDB);
    expect(fs.readdirSync(cacheDir).filter((file) => /\.tmp-/.test(file))).toEqual([]);
  }, 120_000);
});

/*
 * Driven against a real conversion, because pruning only runs when one
 * succeeds — a cache that is never written is a cache that never needs
 * tidying, and testing the tidy without the write would prove nothing.
 */
withRealm('keeping the cache from growing forever', () => {
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

  it('drops the least recently used past the cap', () => {
    const seeded = seedCache(12);
    const copy = path.join(dir, 'realm.mdb');
    fs.copyFileSync(REAL_MDB, copy);
    library().load(copy);

    const left = fs.readdirSync(cacheDir).filter((name) => name.endsWith('.jsonl.gz'));
    expect(left.length).toBeLessThanOrEqual(8);
    // The newest of the seeded ones survives; the oldest does not.
    expect(fs.existsSync(seeded[seeded.length - 1]!)).toBe(true);
    expect(fs.existsSync(seeded[0]!)).toBe(false);
  }, 120_000);
});

/*
 * The realm the client now defaults to, converted from the database that
 * actually ships with it.
 *
 * `GMUD (5X)` is the first shipped realm to name a `database:`, and it names a
 * **relative** path — so what this proves is the whole path a new player takes
 * on their first connection: the file is where the shipped realm says it is,
 * the relative spelling resolves against the resources directory, and 57,511
 * rooms come out the other end rather than a fallback notice and Paradigm's
 * map. Nothing else checks it end to end; `shipped.test.ts` reads the YAML and
 * asserts the file exists, which is not the same as it converting.
 */
describe('the realm database the client ships', () => {
  const SHIPPED_DB = 'mdb/gmud20230902.mdb';
  const resources = path.resolve('resources');

  it('is where the shipped realm says it is', () => {
    // A missing file here is a realm that silently falls back to somebody
    // else's map, which is the one failure the fallback cannot make loud.
    expect(fs.existsSync(path.join(resources, SHIPPED_DB))).toBe(true);
  });

  it('converts through the relative path the realm names', () => {
    const loaded = new RealmLibrary({
      shippedFile,
      cacheDir,
      resourcesDir: resources,
      notify: (message) => notices.push(message)
    }).load(SHIPPED_DB);

    expect(loaded.problem).toBeUndefined();
    // Its own rooms, not the built-in world's three.
    expect(loaded.graph.size).toBeGreaterThan(50_000);
    expect(loaded.graph.info.source).toContain('gmud');
    /*
     * And the races and classes the experience table is derived from came with
     * it, which is half of why a GreaterMUD character wants this map rather
     * than Paradigm's. **This file's own number**, not the one the wire quotes:
     * `orohost` charges a Kang Mystic 285 and this database says 330, because
     * they are different servers running different data. That disagreement is
     * exactly the case `src/shared/experience.ts` marks its derived rows for —
     * the client shows what the realm data implies, says it worked it out, and
     * drops the lot the first time the wire contradicts a row of it.
     */
    expect(loaded.graph.experiencePercent('Kang', 'Mystic')).toBe(330);
  }, 120_000);
});
