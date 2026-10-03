/**
 * The startup split of an old one-file record (`<id><ext>` beside the
 * character directories) into the segments of `segmentFiles.ts`, once, said,
 * with a backup, and resumed after an interruption. What goes into a segment
 * is the caller's (`fightLogMigration.ts`, `backscrollMigration.ts`).
 */
import fs from 'node:fs';
import path from 'node:path';

import { segmentPath, segmentsIn } from './segmentFiles';

/** One kind of record's split from one file into segments. */
export interface OldRecordSplit<R> {
  /** The directory the old files and the new directories are both in. */
  dir: string;
  /** The old file's suffix after the id, and each segment's after its number. */
  ext: string;
  /** Writes `old`'s segments into the empty directory `built`. */
  split(old: string, built: string): Promise<R>;
  /** A file kept beside a segment, moved with it and before it. */
  companion?(dir: string, segment: number): string;
  /** A name in a record's directory a crash left behind, removed when segments move. */
  leftover?(entry: string): boolean;
  /** One record split: where it was, where it is, the copy kept, and what `split` said. */
  done(split: { old: string; target: string; backup: string; result: R }): void;
  /** One record could not be split; it is tried again at the next launch. */
  failed(old: string, error: unknown): void;
  /** `dir` could not be listed. */
  unreadable(dir: string, error: unknown): void;
}

/** Where a character's segments are built before they take the record's place, and back. */
const STAGING = {
  name: (id: string): string => `.${id}.segmenting`,
  id: (entry: string): string | undefined => /^\.(.+)\.segmenting$/.exec(entry)?.[1]
};

/**
 * Every old one-file record under `dir`, split into segments, once, and said.
 * The old file is copied aside first and only removed once its segments are
 * complete; an interrupted run starts that character again on the next
 * launch. Never rejects: a record that cannot be split is said and left as it
 * was.
 */
export async function splitOldRecords<R>(spec: OldRecordSplit<R>): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(spec.dir);
  } catch (error) {
    // No record yet is nothing to split; anything else is said.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') spec.unreadable(spec.dir, error);
    return;
  }
  const ids = new Set<string>();
  for (const entry of names) {
    if (entry.endsWith(spec.ext) && entry.length > spec.ext.length) {
      ids.add(entry.slice(0, entry.length - spec.ext.length));
    }
    // Segments built by a run that stopped after the old file went.
    const built = STAGING.id(entry);
    if (built !== undefined) ids.add(built);
  }
  for (const id of [...ids].sort()) {
    const old = path.join(spec.dir, `${id}${spec.ext}`);
    try {
      await splitOne(spec, id, old);
    } catch (error) {
      spec.failed(old, error);
    }
  }
}

async function splitOne<R>(spec: OldRecordSplit<R>, id: string, old: string): Promise<void> {
  const built = path.join(spec.dir, STAGING.name(id));
  const target = path.join(spec.dir, id);
  if (!(await isFile(old))) {
    await place(spec, built, target);
    return;
  }
  const backup = await backUp(old);
  await fs.promises.rm(built, { recursive: true, force: true });
  await fs.promises.mkdir(built, { recursive: true });
  const result = await spec.split(old, built);
  // The segments are complete: from here a stopped run only has to place them.
  await fs.promises.unlink(old);
  await place(spec, built, target);
  spec.done({ old, target, backup, result });
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(file)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Copies the old file aside, unless an earlier run already did. A copy of
 * another length is somebody's, so the next free name is taken instead.
 */
async function backUp(old: string): Promise<string> {
  const size = (await fs.promises.stat(old)).size;
  for (let n = 1; ; n += 1) {
    const backup = n === 1 ? `${old}.bak` : `${old}.${n}.bak`;
    try {
      if ((await fs.promises.stat(backup)).size === size) return backup;
    } catch {
      await fs.promises.copyFile(old, backup, fs.constants.COPYFILE_EXCL);
      return backup;
    }
  }
}

/**
 * Puts the built segments where the record lives. Segments already there were
 * written after the old file (by a quit while the split was running), so they
 * go after it, renumbered, each companion moved before its segment so a
 * stopped move resumes in order.
 */
async function place<R>(spec: OldRecordSplit<R>, built: string, target: string): Promise<void> {
  if (!fs.existsSync(built)) return;
  if (fs.existsSync(target)) {
    let next = (segmentsIn(built, spec.ext).at(-1) ?? 0) + 1;
    for (const segment of segmentsIn(target, spec.ext)) {
      const companion = spec.companion;
      if (companion !== undefined && fs.existsSync(companion(target, segment))) {
        await fs.promises.rename(companion(target, segment), companion(built, next));
      }
      await fs.promises.rename(
        segmentPath(target, segment, spec.ext),
        segmentPath(built, next, spec.ext)
      );
      next += 1;
    }
    for (const entry of await fs.promises.readdir(target)) {
      if (spec.leftover?.(entry) === true) {
        await fs.promises.rm(path.join(target, entry), { force: true });
      }
    }
    // Only empty: anything else in it is not the record's, and stops the move.
    await fs.promises.rmdir(target);
  }
  await fs.promises.rename(built, target);
}
