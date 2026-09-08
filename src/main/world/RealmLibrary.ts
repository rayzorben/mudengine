import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

import { t } from '../app/i18n';
import { WorldGraph } from './WorldGraph';
import { buildRealm, identityOfArchive, REALM_FORMAT } from './buildRealm';
import { openRealm } from './RealmSource';
import { tuning } from '../app/tuning';
import { REALM_FAMILY_LABEL } from '../../shared/realm';
import {
  asShippedWorld,
  DEFAULT_SHIPPED_WORLD,
  SHIPPED_WORLD_LABEL,
  SHIPPED_WORLDS,
  shippedWorldFile,
  type ArchiveIdentity,
  type ShippedWorld
} from '../../shared/worlds';

/**
 * Every realm the client has been asked for, converted once and kept.
 *
 * The client ships two worlds — stock MajorMUD v1.11p and Paradigm's — and a
 * realm says which it runs at its own menu (`shared/worlds.ts`). That is right
 * for every realm this client has met and wrong for a private one with its own
 * `.mdb`, where a route planned against the wrong world sends a character
 * somewhere that does not exist. So a realm can name a database file instead.
 *
 * The rule that governs this is the one the world knowledge base exists for
 * (docs/legacy-assessment.md §5 consequence 4): **normalise once, never query
 * at runtime.** A chosen file is converted into exactly the form the shipped
 * realm has, written to a cache, and loaded from there — so a per-character
 * database is not the thing that reintroduces per-line database access.
 *
 * Three things worth knowing:
 *
 * - **The cache is keyed on the file's identity, not its path.** Path, size and
 *   modification time: edit the realm and the next launch reconverts, move it
 *   and nothing is rebuilt. A cache keyed on the path alone goes stale silently,
 *   which here means routing against a realm that has changed underneath you.
 * - **A realm that will not convert is reported, and the character falls back
 *   to the shipped one.** Not to *nothing*: a client with no realm data cannot
 *   say where it is, and "the wrong map" beats "no map" only because it is
 *   announced. The fallback is stated every time, not once.
 * - **Graphs are shared between characters that name the same file.** 55,806
 *   rooms indexed twice is a cost nobody asked for, and two characters on one
 *   realm is the ordinary case.
 */
export interface RealmLoad {
  graph: WorldGraph;
  /** What was actually loaded, for the Session card and for a notice. */
  source: string;
  /** Set when the requested file could not be used and a bundled world was. */
  problem?: string;
}

export interface RealmLibraryOptions {
  /**
   * Where the bundled worlds are, one `<world>.jsonl.gz` per `SHIPPED_WORLDS`
   * (`resources/world/` in a checkout, wherever `resourcesDir()` finds it in a
   * package). A missing file loads as an empty world and says so.
   */
  shippedDir: string;
  /** Where converted realms are kept. Created on demand. */
  cacheDir: string;
  /**
   * Where the client's own files are, so a shipped realm can name a database
   * **beside them** rather than a path on the machine that wrote it.
   *
   * No realm ships with a `database:` today: the six that ship are Paradigm's
   * and walk the bundled Paradigm world. `GMUD (5X)` did until 2026-09-05,
   * naming `mdb/2023-09-02-gmud.zip` — and the rule that made it *relative* is
   * why this option exists and why it stays. An absolute path in a shipped
   * file would exist on exactly one computer, which is what `shipped.test.ts`
   * refuses; a relative one resolves against wherever the client was actually
   * installed.
   *
   * Optional: everything that constructs this without one — a test, a probe —
   * is naming absolute paths anyway, and a relative path with nowhere to
   * resolve against is left alone to fail as the missing file it is.
   */
  resourcesDir?: string;
  /** Reported to the terminal. Converting a large realm is not instant. */
  notify?(message: string): void;
}

export class RealmLibrary {
  /** By cache key, so two characters on one realm share one index. */
  private readonly graphs = new Map<string, WorldGraph>();
  /** The bundled worlds, each loaded once and kept for the process's life. */
  private readonly shipped = new Map<ShippedWorld, WorldGraph>();
  /**
   * The bundled worlds' headers, read without indexing them, so a database a
   * player names can be matched against the archives they were built from
   * before either is loaded whole. Read once; a missing world reads as null.
   */
  private archives: Map<ShippedWorld, ArchiveIdentity> | null = null;
  /**
   * Which bundled world a named database turned out to **be**, by the same
   * identity key the conversions use, so the verdict is reached — and said —
   * once. `load` runs on every world query, so every repeat path here is
   * obliged to be quiet and cheap; see "The world knowledge base" in the
   * skill. A negative verdict is kept too, so a private realm that merely
   * matches an archive's size pays for the hash once.
   */
  private readonly bundledWorlds = new Map<string, ShippedWorld | null>();
  /**
   * The bundled worlds already announced as the automatic choice. Walking a
   * map the realm has not confirmed is a standing condition, not an event.
   */
  private readonly announcedAutomatic = new Set<ShippedWorld>();

  constructor(private readonly options: RealmLibraryOptions) {}

  /** Where one bundled world is kept. */
  private shippedFile(world: ShippedWorld): string {
    return path.join(this.options.shippedDir, shippedWorldFile(world));
  }

  /**
   * One of the worlds the client ships. Loaded once, kept for the process's life.
   *
   * Says what it found, once per world. In a packaged build the resources
   * directory is somewhere else entirely and `resourcesDir()` probes candidates
   * to find it — so "57,511 rooms" at startup is the difference between a
   * working package and one that silently cannot say where anybody is standing.
   */
  shippedGraph(world: ShippedWorld = DEFAULT_SHIPPED_WORLD): WorldGraph {
    const held = this.shipped.get(world);
    if (held) return held;
    const started = Date.now();
    const file = this.shippedFile(world);
    const graph = WorldGraph.load(file);
    this.shipped.set(world, graph);
    if (graph.size > 0) {
      this.options.notify?.(
        t('notices.world.shippedLoaded', {
          rooms: graph.size.toLocaleString(),
          source: SHIPPED_WORLD_LABEL[world],
          ms: Date.now() - started
        })
      );
      this.announceBuild(graph);
    } else {
      this.options.notify?.(t('notices.world.shippedMissing', { path: file }));
    }
    return graph;
  }

  /**
   * The bundled world a database file *is*, if it is one.
   *
   * By content, never by name: `pmud.zip` is anybody's name for anything, and
   * the four realm files on the machine this was written on named the very
   * archives the bundled worlds are built from by absolute path. Converting
   * those again would only file what is learned against them under a second
   * name. The size is compared first — a `stat` — and the hash only when a
   * size agrees, so a private realm costs no read at all.
   */
  private bundledFor(file: string): ShippedWorld | null {
    if (this.archives === null) {
      this.archives = new Map();
      for (const world of SHIPPED_WORLDS) {
        const archive = WorldGraph.meta(this.shippedFile(world))?.archive ?? null;
        if (archive !== null) this.archives.set(world, archive);
      }
    }
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return null;
    }
    const candidates = [...this.archives].filter(([, archive]) => archive.size === size);
    if (candidates.length === 0) return null;
    const sha1 = identityOfArchive(file).sha1;
    return candidates.find(([, archive]) => archive.sha1 === sha1)?.[0] ?? null;
  }

  /**
   * What the realm database says about itself, said out loud once per realm.
   *
   * The `Info` row was in every realm file this client has ever read and
   * invisible to it until format 21 — not the data set's version, not its build
   * date, not which of the two lineages' arithmetic it belongs to. It is
   * announced rather than merely stored because **provenance is part of the
   * answer**: a derived number has to be able to say which build of which data
   * it came from, and the first place a person looks for that is the line that
   * already tells them how many rooms loaded.
   *
   * A realm that does **not** name a family says so in the same sentence,
   * because that is a refusal — everything downstream of it will decline to
   * compute — and a safety feature that declines silently is worse than one
   * never offered.
   *
   * Once per graph: `shippedGraph` memoises and `load` announces only on the
   * path that has just read a file, so switching between two converted realms
   * does not re-announce either.
   */
  private announceBuild(graph: WorldGraph): void {
    const { build, family, source } = graph.info;
    if (build === null) return;
    const stated = [build.custom, build.data === null ? null : `data ${build.data}`, build.date]
      .filter((part): part is string => part !== null && part.length > 0)
      .join(', ');
    if (stated.length === 0) return;
    this.options.notify?.(
      t('notices.world.realmBuild', {
        source,
        build: stated,
        family:
          family === null ? t('notices.world.realmBuildFamilyUnknown') : REALM_FAMILY_LABEL[family]
      })
    );
  }

  /**
   * A database path as an absolute one.
   *
   * A path a *player* typed is theirs and is used as given — the file picker
   * produces absolute paths and so does anybody typing one. A **relative** path
   * can only have come from a file this client ships, so it resolves against
   * the resources directory, which is `resources/` in a checkout and somewhere
   * else entirely inside a package.
   *
   * Resolved here rather than at the call site because the cache is keyed on
   * the path: two spellings of one file would convert it twice and index
   * 57,511 rooms twice, and `identity()` cannot tell them apart.
   */
  private resolve(database: string): string {
    if (database.length === 0) return database;
    const root = this.options.resourcesDir;
    if (root === undefined || path.isAbsolute(database)) return database;
    return path.join(root, database);
  }

  /**
   * The realm for a character, converting it if this is the first time.
   *
   * `database` is the realm's own statement: empty, a bundled world's name, or
   * a file. Empty means *whatever this realm has said it runs* — `learned`,
   * from its menu prompt on an earlier connection — and until it has said,
   * the default world, announced, so that walking a map the realm has not
   * confirmed is never silent. A file that turns out to be the very archive a
   * bundled world was built from loads that world instead (`bundledFor`).
   *
   * Synchronous, deliberately, and only ever called when a session is being
   * built rather than while one is running: converting 57,511 rooms takes a
   * couple of seconds, and doing it on a background tick would mean a character
   * connecting into a realm that is not there yet and resolving every room
   * against nothing.
   */
  load(database: string, learned: ShippedWorld | null = null): RealmLoad {
    const stated = database.trim();
    const automatic = learned ?? DEFAULT_SHIPPED_WORLD;
    const bundled = (world: ShippedWorld): RealmLoad => {
      const graph = this.shippedGraph(world);
      return { graph, source: graph.info.source || t('notices.world.shippedRealmLabel') };
    };

    if (stated.length === 0) {
      if (learned === null && !this.announcedAutomatic.has(automatic)) {
        this.announcedAutomatic.add(automatic);
        this.options.notify?.(
          t('notices.world.automaticWorld', { world: SHIPPED_WORLD_LABEL[automatic] })
        );
      }
      return bundled(automatic);
    }
    const named = asShippedWorld(stated);
    if (named !== null) return bundled(named);

    const wanted = this.resolve(stated);
    const fallback = (problem: string): RealmLoad => {
      this.options.notify?.(
        t('notices.world.fallback', { problem, world: SHIPPED_WORLD_LABEL[automatic] })
      );
      return { ...bundled(automatic), problem };
    };

    let key: string;
    try {
      key = identity(wanted);
    } catch (error) {
      return fallback(
        t('notices.world.problemUnreadableIdentity', { path: wanted, reason: reason(error) })
      );
    }

    const cached = this.graphs.get(key);
    if (cached) return { graph: cached, source: cached.info.source };

    let same = this.bundledWorlds.get(key);
    if (same === undefined) {
      same = this.bundledFor(wanted);
      this.bundledWorlds.set(key, same);
      if (same !== null)
        this.options.notify?.(
          t('notices.world.archiveIsBundled', {
            file: path.basename(wanted),
            world: SHIPPED_WORLD_LABEL[same]
          })
        );
    }
    if (same !== null) return bundled(same);

    const cacheFile = path.join(this.options.cacheDir, `${key}.jsonl.gz`);
    if (!fs.existsSync(cacheFile)) {
      const built = this.convert(wanted, cacheFile);
      if (built !== null) return fallback(built);
      this.prune();
    }

    const graph = WorldGraph.load(cacheFile);
    if (graph.size === 0) {
      return fallback(t('notices.world.problemEmptyConversion', { file: path.basename(wanted) }));
    }
    this.graphs.set(key, graph);
    this.announceBuild(graph);
    return { graph, source: graph.info.source };
  }

  /**
   * Drops the least recently used conversions past the cap.
   *
   * By access time where the filesystem offers one and modification time
   * otherwise, so a realm somebody switches back to regularly survives even
   * though it is never rewritten. Failures are ignored: a cache that cannot be
   * tidied is untidy, not broken.
   */
  private prune(): void {
    try {
      const files = fs
        .readdirSync(this.options.cacheDir)
        .filter((name) => name.endsWith('.jsonl.gz'))
        .map((name) => {
          const full = path.join(this.options.cacheDir, name);
          const stat = fs.statSync(full);
          return { full, used: Math.max(stat.atimeMs, stat.mtimeMs) };
        })
        .sort((a, b) => b.used - a.used);

      for (const stale of files.slice(tuning().world.keepRealms))
        fs.rmSync(stale.full, { force: true });
    } catch {
      // Nothing here is load-bearing.
    }
  }

  /** Converts a realm into the cache. Returns a problem, or null on success. */
  private convert(file: string, cacheFile: string): string | null {
    this.options.notify?.(t('notices.world.converting', { file: path.basename(file) }));
    const started = Date.now();
    try {
      const source = openRealm(file);
      const built = buildRealm(source, new Date().toISOString().slice(0, 10));
      source.close();

      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const body = [JSON.stringify(built.header), ...built.lines].join('\n') + '\n';
      // Written to a temporary file and renamed: a crash or a second window
      // converting the same realm must not leave a half-written cache that
      // loads as a realm with a few thousand rooms in it.
      const temporary = `${cacheFile}.tmp-${process.pid}`;
      fs.writeFileSync(temporary, zlib.gzipSync(body, { level: 9 }));
      fs.renameSync(temporary, cacheFile);

      this.options.notify?.(
        t('notices.world.converted', {
          file: path.basename(file),
          rooms: built.stats.rooms.toLocaleString(),
          seconds: ((Date.now() - started) / 1000).toFixed(1)
        })
      );
      return null;
    } catch (error) {
      return t('notices.world.problemConvertFailed', {
        file: path.basename(file),
        reason: reason(error)
      });
    }
  }
}

/**
 * A key for what this file *is*, not where it lives.
 *
 * Path, size and modification time. Edit the realm and the next launch
 * reconverts; move it and nothing is rebuilt. A cache keyed on the path alone
 * goes stale in silence, which here means planning routes against a realm that
 * has changed underneath you.
 *
 * **And the format version, for the same reason.** A conversion made by an
 * older build is a file that has not changed and is no longer the whole
 * answer: v5 added whether a monster attacks on sight, and a cached v4 realm
 * says *no* to that about every monster in it. Without this the client would
 * go on reading it for as long as the realm file itself sat untouched, which
 * for a database somebody downloaded once is for ever.
 *
 * Hashed rather than used raw so the result is a legal filename on every
 * platform whatever the path contained.
 */
function identity(file: string): string {
  const stat = fs.statSync(file);
  return crypto
    .createHash('sha1')
    .update(`v${REALM_FORMAT}|${path.resolve(file)}|${stat.size}|${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 16);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
