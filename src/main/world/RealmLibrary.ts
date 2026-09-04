import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

import { t } from '../app/i18n';
import { WorldGraph } from './WorldGraph';
import { buildRealm, REALM_FORMAT } from './buildRealm';
import { openRealm } from './RealmSource';
import { tuning } from '../app/tuning';

/**
 * Every realm the client has been asked for, converted once and kept.
 *
 * The client ships one realm and that is right for the common case and wrong
 * for anybody on a derivative: Paradigm and every private realm have their own
 * `.mdb`, and a route planned against the wrong one sends a character somewhere
 * that does not exist. So a character can name a realm file.
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
  /** Set when the requested file could not be used and the shipped one was. */
  problem?: string;
}

export interface RealmLibraryOptions {
  /** The realm the client ships, used when a character names none. */
  shippedFile: string;
  /** Where converted realms are kept. Created on demand. */
  cacheDir: string;
  /**
   * Where the client's own files are, so a shipped realm can name a database
   * **beside them** rather than a path on the machine that wrote it.
   *
   * `resources/servers/gmud-5x/server.yaml` says `database:
   * mdb/gmud20230902.mdb`, and that file ships. An absolute path there would
   * exist on exactly one computer, which is why `shipped.test.ts` refused one
   * for as long as every shipped realm used the built-in world — and why the
   * answer is a *relative* path rather than an exception to that rule.
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
  private shipped: WorldGraph | null = null;

  constructor(private readonly options: RealmLibraryOptions) {}

  /**
   * The realm the client ships. Loaded once, kept for the process's life.
   *
   * Says what it found, once. In a packaged build the resources directory is
   * somewhere else entirely and `resourcesDir()` probes candidates to find it —
   * so "55,806 rooms" at startup is the difference between a working package
   * and one that silently cannot say where anybody is standing.
   */
  shippedGraph(): WorldGraph {
    if (this.shipped) return this.shipped;
    const started = Date.now();
    const graph = WorldGraph.load(this.options.shippedFile);
    this.shipped = graph;
    if (graph.size > 0) {
      this.options.notify?.(
        t('notices.world.shippedLoaded', {
          rooms: graph.size.toLocaleString(),
          source: graph.info.source,
          ms: Date.now() - started
        })
      );
    } else {
      this.options.notify?.(t('notices.world.shippedMissing', { path: this.options.shippedFile }));
    }
    return graph;
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
   * Synchronous, deliberately, and only ever called when a session is being
   * built rather than while one is running: converting 55,806 rooms takes a
   * couple of seconds, and doing it on a background tick would mean a character
   * connecting into a realm that is not there yet and resolving every room
   * against nothing.
   */
  load(database: string): RealmLoad {
    const wanted = this.resolve(database.trim());
    if (wanted.length === 0) {
      const graph = this.shippedGraph();
      return { graph, source: graph.info.source || t('notices.world.shippedRealmLabel') };
    }

    const fallback = (problem: string): RealmLoad => {
      this.options.notify?.(t('notices.world.fallback', { problem }));
      const graph = this.shippedGraph();
      return { graph, source: graph.info.source || t('notices.world.shippedRealmLabel'), problem };
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
