import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import MDBReader from 'mdb-reader';

import { isZip, readZipEntry, zipEntries } from './zip';
import type { ZipEntry } from './zip';

/**
 * Reading realm content out of whatever a player has.
 *
 * The realm database ships in two shapes and this project has met both: the
 * Access `.mdb` that the game's own tooling produces and that every derivative
 * distributes, and a SQLite extraction of one. They carry the same tables with
 * the same column names, so the difference is entirely in how the bytes are
 * read — which is what this hides.
 *
 * **And in either shape it may arrive zipped**, which is how a realm is
 * actually distributed and, since 2026-09-04, how this repository keeps its own:
 * a 20 MB Access file is 2.4 MB compressed, so the loose copy was eight times
 * the size of the archive in the installer and in every clone. A `.zip` holding
 * exactly one realm file is read straight out of the archive — see `zip.ts` —
 * because the alternative is asking a player to unpack it first, and a step
 * between downloading a realm and using it is a step that gets skipped.
 *
 * Two rules it exists to keep:
 *
 * - **Read, never query.** Callers ask for whole tables and normalise once.
 *   docs/legacy-assessment.md §5 consequence 4: the CoffeeScript engine issued
 *   synchronous SQLite queries from inside block parsing, per line, on the main
 *   thread. Nothing here offers a `where`, so nothing can do that again.
 * - **A realm file is untrusted input.** It is a file a player points at. A
 *   missing table, an absent column, a row with a null where a number belongs:
 *   each is reported, none throws into whatever was walking at the time.
 */
export interface RealmTable {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface RealmSource {
  /** For messages, and for keying a cache on what it was built from. */
  readonly path: string;
  readonly kind: 'mdb' | 'sqlite';
  tableNames(): string[];
  /** Every row of one table, or null if the file does not have it. */
  table(name: string): RealmTable | null;
  close(): void;
}

/**
 * How a realm file is recognised.
 *
 * By extension, because the alternative is sniffing magic bytes for two formats
 * whose readers both want the whole file anyway. A file named something else is
 * refused rather than guessed at — a wrong guess here means a confident,
 * silent, empty realm.
 */
export function realmKind(file: string): 'mdb' | 'sqlite' | null {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.mdb' || extension === '.accdb') return 'mdb';
  if (extension === '.sqlite' || extension === '.db' || extension === '.sqlite3') return 'sqlite';
  return null;
}

/**
 * Every extension `openRealm` accepts, for the file picker and for prose.
 *
 * Here rather than beside the picker because it is the same closed union
 * `realmKind` and `isZip` decide between, and a list of extensions the dialog
 * offers that the reader then refuses is a file a player can choose and not
 * use. The archive is last: it is the container, not a shape of its own.
 */
export const REALM_EXTENSIONS = ['mdb', 'accdb', 'sqlite', 'db', 'sqlite3', 'zip'] as const;

/**
 * Either reader, chosen by extension — through a zip, when that is what it is.
 *
 * Throws only on a file it cannot open, and the message says which of the two
 * it was: a path that is not there, or a file that is not a realm.
 */
export function openRealm(file: string): RealmSource {
  if (!fs.existsSync(file)) throw new Error(`No realm database at ${file}`);
  if (isZip(file)) return openArchivedRealm(file);
  const kind = realmKind(file);
  if (kind === null) {
    throw new Error(
      `${path.basename(file)}: not a realm database. ` +
        'Expected .mdb, .accdb, .sqlite, .db, or a .zip holding one of them.'
    );
  }
  return kind === 'mdb' ? new MdbSource(file, () => fs.readFileSync(file)) : new SqliteSource(file);
}

/**
 * The realm inside an archive.
 *
 * **Exactly one, or it refuses.** A zip holding two databases is a question
 * nobody here can answer — the newer one, the bigger one and the one whose name
 * looks right are three different guesses, and the wrong one is a map that is
 * confidently, silently elsewhere. So the archive is asked what it holds and,
 * when the answer is not a single realm, that is what is reported: the whole
 * point of naming the contents in the message is that the player can unzip it
 * and name the file they meant.
 *
 * Empty entries are not candidates. A zero-byte `.mdb` is not a realm, and
 * counting one would turn "holds no database" into an ambiguity.
 */
function openArchivedRealm(file: string): RealmSource {
  const label = path.basename(file);
  const held = zipEntries(file).filter((entry) => entry.size > 0);
  const realms = held.filter((entry) => realmKind(entry.name) !== null);

  if (realms.length === 0) {
    throw new Error(
      `${label}: holds no realm database. Expected an .mdb, .accdb, .sqlite or .db inside it` +
        (held.length === 0 ? ', and it is empty.' : `, and it holds ${listed(held)}.`)
    );
  }
  if (realms.length > 1) {
    throw new Error(
      `${label}: holds ${realms.length} realm databases (${listed(realms)}). ` +
        'Unzip it and name the one you want.'
    );
  }

  const entry = realms[0] as ZipEntry;
  return realmKind(entry.name) === 'mdb'
    ? new MdbSource(file, () => readZipEntry(file, entry))
    : archivedSqlite(file, entry);
}

/** Names for a message, bounded: an archive may hold a great many files. */
function listed(entries: ZipEntry[]): string {
  const names = entries.slice(0, 4).map((entry) => entry.name);
  return entries.length > names.length
    ? `${names.join(', ')} and ${entries.length - 4} more`
    : names.join(', ');
}

/**
 * A `.sqlite` inside an archive, unpacked to a temporary file.
 *
 * The SQLite reader shells out to the `sqlite3` CLI, deliberately (see
 * `SqliteSource`), and a CLI needs a path — so this is the one shape that
 * cannot be read out of memory, and the temporary file is not an optimisation
 * to be avoided but the only way to read it at all.
 *
 * Unpacked when the realm is opened rather than on first use, unlike
 * `MdbSource`: laziness buys nothing once the bytes have to reach the
 * filesystem anyway, and a temporary file created inside a getter is one whose
 * owner cannot be sure it exists to remove. It goes in a directory of its own
 * so `close()` removes exactly what was written, and `force` makes that safe to
 * call twice.
 *
 * The `path` it reports is the **archive**, not the temporary file: what a
 * realm was built from is what a message names and what a cache is keyed on,
 * and a path under `/tmp` is neither.
 */
function archivedSqlite(file: string, entry: ZipEntry): RealmSource {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-realm-'));
  // `basename` because an entry names a path inside the archive, and one
  // spelled `../../etc/x.db` is a file written outside the directory we own.
  const unpacked = path.join(directory, path.basename(entry.name));
  try {
    fs.writeFileSync(unpacked, readZipEntry(file, entry));
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  const inner = new SqliteSource(unpacked);
  return {
    path: file,
    kind: 'sqlite',
    tableNames: () => inner.tableNames(),
    table: (name) => inner.table(name),
    close: () => {
      inner.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

/**
 * The Access format the game's own tooling produces.
 *
 * `mdb-reader` is pure JavaScript, which matters more here than performance:
 * this runs inside Electron, and a native reader would need `electron-rebuild`
 * per platform — the routine failure point the legacy README admits to, and the
 * reason `better-sqlite3` was refused for the build step in the first place.
 *
 * The whole file is read into memory. A realm database is tens of megabytes and
 * this happens once, when somebody chooses a file, rather than while anything
 * is being played.
 *
 * **Imported statically, and bundled** (`electron.vite.config.ts`). It used to
 * be reached through `createRequire` on the belief that it was CommonJS. It is
 * not — its `package.json` says `"type": "module"` — so in a packaged build
 * every attempt to open an Access realm died with *"require() of ES Module …
 * not supported"*, and the client fell back to the realm it ships with. A
 * player on a derivative therefore had no way to use their own database at
 * all, and the failure named a require they had not written.
 *
 * The same fix `yaml` already has, for the same reason and with the same
 * trade: it is 97 KB of pure JavaScript, so inlining it costs a few kilobytes
 * at startup and removes the runtime resolution entirely.
 */
class MdbSource implements RealmSource {
  readonly kind = 'mdb';
  private reader: MDBReader | null = null;

  /**
   * The bytes are passed in rather than read from `path`, because the same
   * reader serves a loose `.mdb` and one inside an archive — and a reader that
   * knew about zips would be carrying the container's problem into the format's
   * code, the same way `unpad` refuses to put Access's padding in the converter.
   */
  constructor(
    readonly path: string,
    private readonly bytes: () => Buffer
  ) {}

  /** Opened on first use: a realm nobody reads is a file nobody has to load. */
  private open(): MDBReader {
    if (this.reader) return this.reader;
    this.reader = new MDBReader(this.bytes());
    return this.reader;
  }

  tableNames(): string[] {
    return this.open().getTableNames();
  }

  table(name: string): RealmTable | null {
    const reader = this.open();
    // Matched case-insensitively: the same table is `Rooms` in one export and
    // `rooms` in another, and a client that refuses one of them is refusing a
    // realm for a difference nobody chose.
    const actual = reader
      .getTableNames()
      .find((entry) => entry.toLowerCase() === name.toLowerCase());
    if (actual === undefined) return null;
    const table = reader.getTable(actual);
    return {
      name: actual,
      columns: table.getColumnNames(),
      rows: table.getData().map((row) => unpad(row as Record<string, unknown>))
    };
  }

  close(): void {
    this.reader = null;
  }
}

/**
 * Strips Access's fixed-width padding out of a row's text.
 *
 * Access stores a fixed-width text column padded with NULs, and the reader
 * hands them back verbatim. A SQLite extraction of the same database has them
 * gone, so without this the two readers disagree about whether a field is
 * empty — and `"lair": "\u0000"` is not empty, which puts a lair marker on
 * every room in the realm.
 *
 * Done here rather than in the converter because it is a property of *this
 * format*, not of realm data: a converter that knew about NUL padding would be
 * carrying one reader's quirk for every reader.
 */
function unpad(row: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    cleaned[key] = typeof value === 'string' ? value.replace(/\0/g, '').trimEnd() : value;
  }
  return cleaned;
}

/**
 * A SQLite extraction, read through the `sqlite3` CLI.
 *
 * Deliberately a shell-out and not a native module, for the reason recorded in
 * `build-world.mjs`: `better-sqlite3` needs `electron-rebuild` per platform.
 * The cost is that a machine without `sqlite3` cannot read this shape — which
 * is reported as such, rather than as an empty realm.
 */
class SqliteSource implements RealmSource {
  readonly kind = 'sqlite';

  constructor(readonly path: string) {}

  private query(sql: string): Record<string, unknown>[] {
    try {
      const out = execFileSync('sqlite3', ['-json', this.path, sql], {
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024
      });
      const parsed: unknown = JSON.parse(out.trim().length === 0 ? '[]' : out);
      return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      if (/ENOENT/.test(message)) {
        throw new Error(
          'sqlite3 is not installed, so a .sqlite realm cannot be read. ' +
            'An .mdb needs nothing installed.'
        );
      }
      throw new Error(`reading ${path.basename(this.path)}: ${message}`);
    }
  }

  tableNames(): string[] {
    return this.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;").map(
      (row) => String(row['name'])
    );
  }

  table(name: string): RealmTable | null {
    const actual = this.tableNames().find((entry) => entry.toLowerCase() === name.toLowerCase());
    if (actual === undefined) return null;
    const rows = this.query(`SELECT * FROM "${actual.replace(/"/g, '""')}";`);
    return { name: actual, columns: Object.keys(rows[0] ?? {}), rows };
  }

  close(): void {
    // Nothing held open: each query is its own process.
  }
}
