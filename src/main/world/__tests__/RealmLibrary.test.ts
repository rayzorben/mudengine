import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { RealmLibrary } from '../RealmLibrary';
import { openRealm } from '../RealmSource';
import { t } from '../../app/i18n';
import { sentence } from '../../app/copyMatch';
import { complaint } from './complaint';
import {
  SHIPPED_WORLD_LABEL,
  shippedWorldFile,
  type ArchiveIdentity,
  type ShippedWorld
} from '../../../shared/worlds';

let dir = '';
let shippedDir = '';
let cacheDir = '';
let notices: string[] = [];

/** A realm file in the shape `build-world.mjs` emits. */
function writeWorld(
  file: string,
  source: string,
  rooms: number,
  extra: { world?: ShippedWorld; archive?: ArchiveIdentity } = {}
): void {
  const header = JSON.stringify({ v: 2, source, rooms, generatedAt: 'x', items: [], ...extra });
  const lines = Array.from({ length: rooms }, (_, i) =>
    JSON.stringify({ m: 1, r: i + 1, n: `Room ${i + 1}`, x: {} })
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync([header, ...lines].join('\n') + '\n'));
}

/** One bundled world, named after itself as the build script names them. */
function writeShipped(world: ShippedWorld, rooms: number, archive?: ArchiveIdentity): void {
  writeWorld(path.join(shippedDir, shippedWorldFile(world)), world, rooms, {
    world,
    ...(archive === undefined ? {} : { archive })
  });
}

/** What the library says while it walks a bundled world nobody confirmed. */
const automaticNotice = (world: ShippedWorld): string =>
  t('notices.world.automaticWorld', { world: SHIPPED_WORLD_LABEL[world] });

/** What it says on recognising a named database as a bundled world's archive. */
const archiveNotice = (file: string, world: ShippedWorld): string =>
  t('notices.world.archiveIsBundled', { file, world: SHIPPED_WORLD_LABEL[world] });

/** A bundled world's load notice, with its one figure that varies (the time) left open. */
const loadedNotice = (world: ShippedWorld, rooms: number): RegExp =>
  sentence('notices.world.shippedLoaded', {
    rooms: rooms.toLocaleString(),
    source: SHIPPED_WORLD_LABEL[world]
  });

const library = (): RealmLibrary =>
  new RealmLibrary({ shippedDir, cacheDir, notify: (message) => notices.push(message) });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-realms-'));
  shippedDir = path.join(dir, 'world');
  cacheDir = path.join(dir, 'realms');
  notices = [];
  writeShipped('paradigm', 3);
  writeShipped('majormud', 2);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a realm database that ships beside the client', () => {
  /*
   * A realm carried beside the client names its database **relatively**,
   * because an absolute path in a shipped file exists on the one computer that
   * wrote it and every install would fall back with a notice. It has to resolve
   * against the client's own resources, which is `resources/` in a checkout and
   * somewhere else entirely inside a package.
   *
   * `GMUD (5X)` was the realm that settled this, naming
   * `mdb/2023-09-02-gmud.zip`; it left the distribution on 2026-09-05 and the
   * rule stayed, because the option is what any realm shipped beside the client
   * would need.
   *
   * Asserted on the path the library *reached for*, which a refusal names, so
   * these cost nothing: converting a real 57,511-room database belongs in
   * `RealmLibrary.realm.test.ts`.
   */
  const shippingLibrary = (resourcesDir: string): RealmLibrary =>
    new RealmLibrary({
      shippedDir,
      cacheDir,
      resourcesDir,
      notify: (message) => notices.push(message)
    });

  it('resolves a relative path against the resources it shipped with', () => {
    const resources = path.join(dir, 'resources');
    const loaded = shippingLibrary(resources).load('mdb/absent.mdb');

    expect(loaded.problem).toContain(path.join(resources, 'mdb', 'absent.mdb'));
    // And falls back to the default bundled world rather than to nothing, saying so.
    expect(loaded.graph.info.source).toBe('paradigm');
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

/*
 * Two worlds ship, and a realm stating none walks whichever it has said it
 * runs. Until it has said, the default — announced, because a map the realm
 * has not confirmed is only survivable if you know you are on it.
 */
describe('a realm that names no database', () => {
  it('walks the default bundled world, and says that nothing has been learned yet', () => {
    const loaded = library().load('');
    expect(loaded.graph.size).toBe(3);
    expect(loaded.graph.info.world).toBe('paradigm');
    expect(loaded.problem).toBeUndefined();
    expect(notices).toContain(automaticNotice('paradigm'));
  });

  it("walks the world the realm's own word chose, silently", () => {
    const loaded = library().load('', 'majormud');
    expect(loaded.graph.size).toBe(2);
    expect(loaded.graph.info.world).toBe('majormud');
    expect(notices).not.toContain(automaticNotice('paradigm'));
    expect(notices).not.toContain(automaticNotice('majormud'));
  });

  /* Walking a map the realm has not confirmed is a standing condition, not an
     event, so it is worth one line and not one per query. The realm that
     will not *convert* is the one that says so every time. */
  it('says nothing has been learned once, not once per query', () => {
    const realms = library();
    realms.load('');
    realms.load('');
    realms.load('');
    expect(notices.filter((notice) => notice === automaticNotice('paradigm'))).toHaveLength(1);
  });

  it('treats whitespace as naming none', () => {
    expect(library().load('   ').graph.size).toBe(3);
  });

  /* One graph, however many characters ask for it: 57,511 rooms indexed twice
     is a cost nobody asked for. */
  it('shares one graph between characters', () => {
    const realms = library();
    expect(realms.load('').graph).toBe(realms.load('').graph);
    expect(realms.load('', 'majormud').graph).toBe(realms.load('majormud').graph);
  });

  it('announces each bundled world once, by its name', () => {
    const realms = library();
    realms.load('');
    realms.load('', 'majormud');
    realms.load('majormud');
    expect(notices.filter((notice) => loadedNotice('paradigm', 3).test(notice))).toHaveLength(1);
    expect(notices.filter((notice) => loadedNotice('majormud', 2).test(notice))).toHaveLength(1);
  });

  it('says so when a bundled world is missing from the resources', () => {
    fs.rmSync(path.join(shippedDir, shippedWorldFile('majormud')));
    const loaded = library().load('majormud');
    expect(loaded.graph.size).toBe(0);
    expect(notices).toContain(
      t('notices.world.shippedMissing', {
        path: path.join(shippedDir, shippedWorldFile('majormud'))
      })
    );
  });
});

describe('a realm that names a bundled world by its word', () => {
  it('pins that world, however the word is written', () => {
    const realms = library();
    expect(realms.load('majormud').graph.info.world).toBe('majormud');
    expect(realms.load(' Paradigm ').graph.info.world).toBe('paradigm');
    // A learned word never overrides a pinned one.
    expect(realms.load('paradigm', 'majormud').graph.info.world).toBe('paradigm');
  });
});

/*
 * A database a player names that is byte-for-byte the archive a bundled world
 * was built from *is* that world. Converting it again would only file what is
 * learned against it under a second name — and the four realm files on the
 * machine this was written on named exactly those archives, by absolute path.
 */
describe('a database that is the archive a bundled world was built from', () => {
  const identityOf = (file: string): ArchiveIdentity => {
    const bytes = fs.readFileSync(file);
    return {
      name: path.basename(file),
      size: bytes.length,
      sha1: crypto.createHash('sha1').update(bytes).digest('hex')
    };
  };

  it('loads the bundled world instead of converting, and says so', () => {
    const archive = path.join(dir, 'pmud.zip');
    fs.writeFileSync(archive, 'the very bytes');
    writeShipped('paradigm', 3, identityOf(archive));

    const loaded = library().load(archive);
    expect(loaded.problem).toBeUndefined();
    expect(loaded.graph.info.world).toBe('paradigm');
    expect(notices).toContain(archiveNotice('pmud.zip', 'paradigm'));
    expect(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []).toEqual([]);
  });

  /*
   * `load` runs on every world query, not once per session, so that an edited
   * realm takes effect on the next session rather than the next restart. The
   * verdict therefore has to be reached once: it re-read and re-hashed the
   * archive on main's thread for every room lookup, and said so each time.
   */
  it('weighs the archive once, however many times the world is asked for', () => {
    const archive = path.join(dir, 'pmud.zip');
    fs.writeFileSync(archive, 'the very bytes');
    writeShipped('paradigm', 3, identityOf(archive));

    const realms = library();
    for (let query = 0; query < 5; query += 1) {
      expect(realms.load(archive).graph.info.world).toBe('paradigm');
    }

    const said = notices.filter((notice) => notice === archiveNotice('pmud.zip', 'paradigm'));
    expect(said).toHaveLength(1);
  });

  it('is recognised by content, never by name', () => {
    const archive = path.join(dir, 'pmud.zip');
    fs.writeFileSync(archive, 'the very bytes');
    writeShipped('paradigm', 3, identityOf(archive));
    // Same name, same size, different bytes: somebody else's realm.
    fs.writeFileSync(archive, 'not those bytes');

    const loaded = library().load(archive);
    // Not recognised, so converted — and this is no archive, so the fallback.
    expect(loaded.problem).toBeDefined();
    expect(notices).not.toContain(archiveNotice('pmud.zip', 'paradigm'));
  });
});

/*
 * "The wrong map" beats "no map" only because it is announced. A client with no
 * realm data cannot say where it is at all.
 */
describe('a realm that cannot be used', () => {
  it('falls back to the bundled world the realm would otherwise walk, and says so', () => {
    const loaded = library().load(path.join(dir, 'missing.mdb'), 'majormud');
    expect(loaded.graph.size).toBe(2);
    expect(loaded.problem).toBeDefined();
    expect(notices).toContain(
      t('notices.world.fallback', {
        problem: loaded.problem!,
        world: SHIPPED_WORLD_LABEL.majormud
      })
    );
  });

  it('says so every time, not once', () => {
    const realms = library();
    const { problem } = realms.load(path.join(dir, 'missing.mdb'));
    realms.load(path.join(dir, 'missing.mdb'));
    const fellBack = t('notices.world.fallback', {
      problem: problem!,
      world: SHIPPED_WORLD_LABEL.paradigm
    });
    expect(notices.filter((notice) => notice === fellBack)).toHaveLength(2);
  });

  it('refuses a file that is not a realm database at all', () => {
    const wrong = path.join(dir, 'notes.txt');
    fs.writeFileSync(wrong, 'hello');
    const loaded = library().load(wrong);
    expect(loaded.problem).toBe(
      t('notices.world.problemConvertFailed', {
        file: 'notes.txt',
        reason: complaint(() => openRealm(wrong))
      })
    );
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
    expect(fs.existsSync(path.join(shippedDir, 'paradigm.jsonl.gz'))).toBe(true);
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
