/**
 * What a store watches, stated as data, and the two ways of reading it.
 *
 * `Poller` reads it on every check without holding the thread: on Azure Files
 * each `stat` and `readdir` is a network round trip, and the synchronous
 * listing held main for 250 ms to 2.2 s every few seconds (717 stalls in
 * 103 minutes, 2026-10-11, `logs/stalls/stalls.log`), which a player feels as
 * typing lag. A settle, right after a read and rare, reads it synchronously so
 * an edit landing just after the read is still caught (`Poller`'s header).
 * Both readers spell a revision the same way, so the two compare.
 */
import { statSync, readdirSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { directoryNames, directoryNamesLater } from './dirs';

export type Watched =
  /** One file: its size and mtime. */
  | { kind: 'file'; path: string }
  /** The files in `dir` that `accept` takes, each stamped. */
  | { kind: 'files'; dir: string; accept: (name: string) => boolean }
  /** Each visible directory inside `dir`, and what `each` watches in it. */
  | { kind: 'each'; dir: string; each: (id: string) => readonly Watched[] };

/**
 * A revision: each watched path that is there, and its stamp. A missing file
 * or directory has no entry (its going is the change); one that cannot be
 * read is stamped `unreadable:<code>`. Flat, so a store's own write is
 * settled by stamping the one file it wrote (`settleFile`).
 */
export type Revision = Map<string, string>;

/** One spelling of a revision, so two compare as text. */
export function spell(revision: ReadonlyMap<string, string>): string {
  return [...revision]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([at, stamped]) => `${at}=${stamped}`)
    .join('\n');
}

/** One file's stamp now, or null when it is not there. */
export function stampNow(file: string): string | null {
  try {
    return stamp(statSync(file));
  } catch (error) {
    return absent(error);
  }
}

/** Null for a missing file or directory, a state like any other; never a throw. */
function absent(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' ? null : `unreadable:${code ?? 'unknown'}`;
}

/*
 * The spelling, once; the two readers differ only in how they wait.
 */
const stamp = (info: { size: number; mtimeMs: number }): string => `${info.size}:${info.mtimeMs}`;
/** A character's or a realm's directory: there, so a new one is a change and gets a watch. */
const DIRECTORY = 'dir';
const put = (into: Revision, at: string, stamped: string | null): void => {
  if (stamped !== null) into.set(at, stamped);
};

export function revisionNow(watched: readonly Watched[]): Revision {
  const into: Revision = new Map();
  for (const entry of watched) oneNow(entry, into);
  return into;
}

function oneNow(watched: Watched, into: Revision): void {
  switch (watched.kind) {
    case 'file':
      put(into, watched.path, stampNow(watched.path));
      return;
    case 'files': {
      let names: string[];
      try {
        names = readdirSync(watched.dir).filter(watched.accept);
      } catch (error) {
        put(into, watched.dir, absent(error));
        return;
      }
      for (const name of names) {
        const file = path.join(watched.dir, name);
        put(into, file, stampNow(file));
      }
      return;
    }
    case 'each': {
      let ids: string[];
      try {
        ids = directoryNames(watched.dir);
      } catch (error) {
        put(into, watched.dir, absent(error));
        return;
      }
      for (const id of ids) {
        into.set(path.join(watched.dir, id), DIRECTORY);
        for (const inner of watched.each(id)) oneNow(inner, into);
      }
      return;
    }
    default: {
      const unreachable: never = watched;
      return unreachable;
    }
  }
}

export async function revision(watched: readonly Watched[]): Promise<Revision> {
  const into: Revision = new Map();
  await Promise.all(watched.map((entry) => oneLater(entry, into)));
  return into;
}

async function stampLater(file: string): Promise<string | null> {
  try {
    return stamp(await stat(file));
  } catch (error) {
    return absent(error);
  }
}

async function oneLater(watched: Watched, into: Revision): Promise<void> {
  switch (watched.kind) {
    case 'file':
      put(into, watched.path, await stampLater(watched.path));
      return;
    case 'files': {
      let names: string[];
      try {
        names = (await readdir(watched.dir)).filter(watched.accept);
      } catch (error) {
        put(into, watched.dir, absent(error));
        return;
      }
      const files = names.map((name) => path.join(watched.dir, name));
      const stamps = await Promise.all(files.map(stampLater));
      files.forEach((file, index) => put(into, file, stamps[index] ?? null));
      return;
    }
    case 'each': {
      let ids: string[];
      try {
        ids = await directoryNamesLater(watched.dir);
      } catch (error) {
        put(into, watched.dir, absent(error));
        return;
      }
      for (const id of ids) into.set(path.join(watched.dir, id), DIRECTORY);
      await Promise.all(
        ids.flatMap((id) => watched.each(id).map((inner) => oneLater(inner, into)))
      );
      return;
    }
    default: {
      const unreachable: never = watched;
      return unreachable;
    }
  }
}

/**
 * Each directory the watched files sit in, and which names in it are the
 * store's, for `Poller`'s change notification. A directory of directories
 * takes any name, since a character or a realm appearing is a directory.
 */
export async function directoriesOf(
  watched: readonly Watched[]
): Promise<Map<string, (name: string) => boolean>> {
  const found = new Map<string, Array<(name: string) => boolean>>();
  const add = (dir: string, accept: (name: string) => boolean): void => {
    found.set(dir, [...(found.get(dir) ?? []), accept]);
  };
  const walk = async (list: readonly Watched[]): Promise<void> => {
    for (const entry of list) {
      switch (entry.kind) {
        case 'file': {
          const name = path.basename(entry.path);
          add(path.dirname(entry.path), (seen) => seen === name);
          break;
        }
        case 'files':
          add(entry.dir, entry.accept);
          break;
        case 'each': {
          add(entry.dir, () => true);
          const ids = await directoryNamesLater(entry.dir).catch(() => []);
          for (const id of ids) await walk(entry.each(id));
          break;
        }
        default: {
          const unreachable: never = entry;
          return unreachable;
        }
      }
    }
  };
  await walk(watched);
  return new Map(
    [...found].map(([dir, accepts]) => [dir, (name: string) => accepts.some((ok) => ok(name))])
  );
}
