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
import { WorldGraph } from '../WorldGraph';
import { identityOfArchive, REALM_FORMAT } from '../buildRealm';
import { t } from '../../app/i18n';
import {
  SHIPPED_WORLD_LABEL,
  SHIPPED_WORLDS,
  shippedWorldFile,
  type ShippedWorld
} from '../../../shared/worlds';

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
 * It has happened twice now: the realms were zipped on 2026-09-04 and this
 * names the archive, which is the shape the repository keeps them in.
 *
 * **And the archive is the point, not an inconvenience it works around.** This
 * is the only test that converts a real realm out of a real zip, so it is what
 * proves `RealmSource` reads one — the loose `.mdb` it used to name is not in
 * the repository any more, and a fixture would prove the fixture.
 */
const REAL_MDB = process.env['MUDENGINE_TEST_MDB'] ?? path.resolve('mdb/pmud.zip');

let dir = '';
let shippedDir = '';
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

/** What the library says as it starts converting a database. */
const converting = (file: string): string =>
  t('notices.world.converting', { file: path.basename(file) });

const library = (): RealmLibrary =>
  new RealmLibrary({ shippedDir, cacheDir, notify: (message) => notices.push(message) });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-realms-'));
  shippedDir = path.join(dir, 'world');
  cacheDir = path.join(dir, 'realms');
  notices = [];
  // A three-room stand-in for the default bundled world, so a fallback is
  // told from a conversion by size alone.
  writeWorld(path.join(shippedDir, 'paradigm.jsonl.gz'), 'paradigm', 3);
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

/**
 * A copy of the realm, under a name of this test's choosing.
 *
 * **Keeping the extension**, because the extension is how `openRealm` chooses a
 * reader: a `.zip` copied to `realm.mdb` is handed to the Access reader, which
 * refuses it, and the conversion these tests are about never happens. The
 * symptom was an empty cache directory and an assertion about pruning — which
 * is a long way from the cause.
 */
const copyOfRealm = (into: string): string => {
  const copy = path.join(into, `realm${path.extname(REAL_MDB)}`);
  fs.copyFileSync(REAL_MDB, copy);
  return copy;
};

withRealm('converting a realm somebody chose', () => {
  it('reads it, and uses it instead of the shipped one', () => {
    const loaded = library().load(REAL_MDB);
    expect(loaded.problem).toBeUndefined();
    // Not the three-room fixture: this is the real realm.
    expect(loaded.graph.size).toBeGreaterThan(50_000);
    // Named after the file it was built from, archive and all: provenance is
    // half of what a converted realm is for.
    expect(loaded.source).toContain(path.basename(REAL_MDB));
  }, 120_000);

  it('converts once and reads the cache after that', () => {
    library().load(REAL_MDB);
    expect(notices.filter((notice) => notice === converting(REAL_MDB))).toHaveLength(1);

    // A second library, as a second launch would be: the cache is on disk.
    notices = [];
    const loaded = library().load(REAL_MDB);
    expect(loaded.graph.size).toBeGreaterThan(50_000);
    expect(notices).not.toContain(converting(REAL_MDB));
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
    const copy = copyOfRealm(dir);
    library().load(copy);
    expect(fs.readdirSync(cacheDir)).toHaveLength(1);

    // Same bytes, new modification time: a different thing as far as a cache
    // that cannot afford to be stale is concerned.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(copy, later, later);
    notices = [];
    library().load(copy);
    expect(notices.filter((notice) => notice === converting(copy))).toHaveLength(1);
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
    const copy = copyOfRealm(dir);
    library().load(copy);

    const left = fs.readdirSync(cacheDir).filter((name) => name.endsWith('.jsonl.gz'));
    expect(left.length).toBeLessThanOrEqual(8);
    // The newest of the seeded ones survives; the oldest does not.
    expect(fs.existsSync(seeded[seeded.length - 1]!)).toBe(true);
    expect(fs.existsSync(seeded[0]!)).toBe(false);
  }, 120_000);
});

/*
 * A realm a player names for themselves, converted end to end.
 *
 * **The database is the stock MajorMUD archive, and it is also a bundled
 * world.** `mdb/2023-09-02-gmud.zip` took this path until 2026-09-07 — it
 * shipped for two days as `GMUD (5X)`'s own map, then only tested here — and
 * left the repository when the two data sets the client bundles were settled
 * (todo 12). What is left is the path every player who names their own realm
 * takes: a `database:` key, an archive read without unpacking, and the realm's
 * own rooms out the other end rather than a fallback notice and somebody
 * else's map. The relative-versus-absolute spelling it settled is asserted
 * where it still applies (`RealmLibrary.test.ts`).
 *
 * Through a *copy*, deliberately: the archive itself is recognised by its
 * bytes as the bundled MajorMUD world (`bundledFor`), which is the second
 * `describe` below, and the conversion path has to be proved on a file the
 * library cannot short-cut.
 */
describe('a realm database a character names', () => {
  const REALM_DB = 'majormud-v1.11p.zip';
  const resources = path.resolve('mdb');

  it('is where this repository keeps it', () => {
    // A missing file here is a realm that silently falls back to somebody
    // else's map, which is the one failure the fallback cannot make loud.
    expect(fs.existsSync(path.join(resources, REALM_DB))).toBe(true);
  });

  it('converts through the relative path the realm names', () => {
    // Same bytes under a different name: `bundledFor` matches by SHA-1, so a
    // copy is still the bundled world. One byte of padding makes it a
    // stranger's file — the archive reader ignores what follows the central
    // directory, and the conversion is what is under test.
    const mine = path.join(dir, 'mdb');
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(
      path.join(mine, REALM_DB),
      Buffer.concat([fs.readFileSync(path.join(resources, REALM_DB)), Buffer.from([0])])
    );
    const loaded = new RealmLibrary({
      shippedDir,
      cacheDir,
      resourcesDir: mine,
      notify: (message) => notices.push(message)
    }).load(REALM_DB);

    expect(loaded.problem).toBeUndefined();
    // Its own rooms, not the built-in stand-in's three.
    expect(loaded.graph.size).toBe(26_694);
    expect(loaded.graph.info.source).toBe(REALM_DB);
    expect(loaded.graph.info.world).toBeNull();
    /*
     * And the races and classes the experience table is derived from came with
     * it. **This file's own number**: stock v1.11p prices a Kang Mystic at 285,
     * which is also what `orohost` quotes on the wire, while Paradigm's data
     * says 670 — two data sets, two answers, and `src/shared/experience.ts`
     * marks its derived rows so the wire's own figure wins the moment it
     * contradicts one.
     */
    expect(loaded.graph.experiencePercent('Kang', 'Mystic')).toBe(285);

    /*
     * And the database's own account of itself, which format 21 added and
     * which is the whole reason anything downstream may branch on a family.
     *
     * **`Custom`, and never `Legit`.** The databases on this machine settle the
     * claim MudPlay's `RealmType` rests on:
     *
     * | file | Custom | Legit |
     * |---|---|---|
     * | `majormud-v1.11p.zip` (stock MajorMUD) | `Default` | 1 |
     * | `2023-09-02-gmud.zip` (GreaterMUD, no longer kept) | `Gmud 1.6 Final` | 0 |
     * | `pmud.zip` (Paradigm) | `Paradigm` | 2 |
     *
     * MudPlay reads `Legit == 2` as GreaterMUD. On these files it is the
     * *Paradigm* database that says 2 and the GreaterMUD one that said 0, so
     * that rule would name every one of them the wrong lineage. Recorded in
     * docs/game-behaviour.md; asserted here so a conversion that starts reading
     * the wrong column fails rather than quietly answering backwards.
     */
    const build = loaded.graph.info.build;
    expect(build?.custom).toBe('Default');
    expect(build?.data).toBe('v1.11p');
    expect(build?.legit).toBe(1);
    expect(loaded.graph.info.family).toBe('majormud');
  }, 120_000);
});

/*
 * The two worlds the client ships, and the archives they were built from.
 *
 * Both lineages of this game's data, each named after itself, each carrying
 * the SHA-1 of the archive in `mdb/` it came from — which is what lets a realm
 * naming that archive walk the bundled world instead of converting it. The
 * identity is asserted against the archives on disk, so a world rebuilt from
 * a newer archive without committing it, or the reverse, fails here rather
 * than silently disagreeing with the file a player names.
 */
describe('the worlds the client ships', () => {
  const ARCHIVES: Record<ShippedWorld, string> = {
    majormud: path.resolve('mdb/majormud-v1.11p.zip'),
    paradigm: path.resolve('mdb/pmud.zip')
  };

  it.each(SHIPPED_WORLDS)('%s is built from the archive this repository keeps', (world) => {
    const meta = WorldGraph.meta(path.resolve('resources/world', shippedWorldFile(world)));
    expect(meta?.version).toBe(REALM_FORMAT);
    expect(meta?.world).toBe(world);
    expect(meta?.source).toBe(world);
    expect(meta?.archive).toEqual(identityOfArchive(ARCHIVES[world]));
  });

  it('reads both as the MajorMUD lineage, each by its own name for itself', () => {
    /*
     * Stock v1.11p calls itself `Default` and Paradigm calls itself
     * `Paradigm`; both descend from MajorMUD and run its arithmetic. The
     * GreaterMUD family is a *server* — `orohost` runs Paradigm's data behind
     * GreaterMUD's formulas — and `SessionManager` says so out loud when the
     * wire's family and the data's disagree, rather than picking one.
     */
    const majormud = WorldGraph.meta(path.resolve('resources/world/majormud.jsonl.gz'));
    expect(majormud?.build?.custom).toBe('Default');
    expect(majormud?.build?.data).toBe('v1.11p');
    expect(majormud?.family).toBe('majormud');

    const paradigm = WorldGraph.meta(path.resolve('resources/world/paradigm.jsonl.gz'));
    expect(paradigm?.build?.custom).toBe('Paradigm');
    expect(paradigm?.build?.legit).toBe(2);
    expect(paradigm?.family).toBe('majormud');
  });

  it('recognises the archive itself as the bundled world, by its bytes', () => {
    const loaded = new RealmLibrary({
      shippedDir: path.resolve('resources/world'),
      cacheDir,
      notify: (message) => notices.push(message)
    }).load(ARCHIVES.majormud);
    expect(loaded.problem).toBeUndefined();
    expect(loaded.graph.info.world).toBe('majormud');
    expect(loaded.graph.size).toBe(26_694);
    expect(notices).toContain(
      t('notices.world.archiveIsBundled', {
        file: path.basename(ARCHIVES.majormud),
        world: SHIPPED_WORLD_LABEL.majormud
      })
    );
    // Nothing was converted: the cache stays empty.
    expect(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []).toEqual([]);
  });
});
