import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import MDBReader from 'mdb-reader';

/**
 * Reading realm content out of whatever a player has.
 *
 * The realm database ships in two shapes and this project has met both: the
 * Access `.mdb` that the game's own tooling produces and that every derivative
 * distributes, and a SQLite extraction of one. They carry the same tables with
 * the same column names, so the difference is entirely in how the bytes are
 * read — which is what this hides.
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

/** Either reader, chosen by extension. Throws only on a file it cannot open. */
export function openRealm(file: string): RealmSource {
  const kind = realmKind(file);
  if (kind === null) {
    throw new Error(
      `${path.basename(file)}: not a realm database. Expected .mdb, .accdb, .sqlite or .db.`
    );
  }
  if (!fs.existsSync(file)) throw new Error(`No realm database at ${file}`);
  return kind === 'mdb' ? new MdbSource(file) : new SqliteSource(file);
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

  constructor(readonly path: string) {}

  /** Opened on first use: a realm nobody reads is a file nobody has to load. */
  private open(): MDBReader {
    if (this.reader) return this.reader;
    this.reader = new MDBReader(fs.readFileSync(this.path));
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
