/**
 * What a store watches, stated as data, and the two ways of reading it.
 *
 * `Poller` reads it twice a second without holding the thread: on Azure Files
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

/** A missing file or directory is a state like any other, never a throw. */
function absent(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : `unreadable:${code ?? 'unknown'}`;
}

/*
 * The spelling, once; the two readers differ only in how they wait.
 */
const stamp = (info: { size: number; mtimeMs: number }): string => `${info.size}:${info.mtimeMs}`;
const spellAll = (parts: readonly string[]): string => parts.join('|');
const spellFiles = (names: readonly string[], stamps: readonly string[]): string =>
  names.map((name, index) => `${name}=${stamps[index]}`).join(',');
const spellEach = (ids: readonly string[], inside: readonly string[]): string =>
  ids.map((id, index) => `${id}{${inside[index]}}`).join(',');
const fileIn = (dir: string, name: string): Watched => ({
  kind: 'file',
  path: path.join(dir, name)
});

export function revisionNow(watched: readonly Watched[]): string {
  return spellAll(watched.map(oneNow));
}

function oneNow(watched: Watched): string {
  try {
    switch (watched.kind) {
      case 'file':
        return stamp(statSync(watched.path));
      case 'files': {
        const names = readdirSync(watched.dir).filter(watched.accept).sort();
        return spellFiles(
          names,
          names.map((name) => oneNow(fileIn(watched.dir, name)))
        );
      }
      case 'each': {
        const ids = directoryNames(watched.dir);
        return spellEach(
          ids,
          ids.map((id) => revisionNow(watched.each(id)))
        );
      }
      default: {
        const unreachable: never = watched;
        return unreachable;
      }
    }
  } catch (error) {
    return absent(error);
  }
}

export async function revision(watched: readonly Watched[]): Promise<string> {
  return spellAll(await Promise.all(watched.map(oneLater)));
}

async function oneLater(watched: Watched): Promise<string> {
  try {
    switch (watched.kind) {
      case 'file':
        return stamp(await stat(watched.path));
      case 'files': {
        const names = (await readdir(watched.dir)).filter(watched.accept).sort();
        return spellFiles(
          names,
          await Promise.all(names.map((name) => oneLater(fileIn(watched.dir, name))))
        );
      }
      case 'each': {
        const ids = await directoryNamesLater(watched.dir);
        return spellEach(ids, await Promise.all(ids.map((id) => revision(watched.each(id)))));
      }
      default: {
        const unreachable: never = watched;
        return unreachable;
      }
    }
  } catch (error) {
    return absent(error);
  }
}
