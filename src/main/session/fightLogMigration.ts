/**
 * Splits each character's old one-file fight log, `fights/<id>.jsonl.gz`, into
 * the segments of `fightSegments.ts`, once, at startup, and says so. The old
 * file is copied aside first and only removed once its segments are complete;
 * an interrupted run starts that character again on the next launch. Streamed,
 * so a log too large for one string still splits. `mudengine-world` › *Every
 * fight is written down before anybody asks* has the reasons.
 */
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';
import {
  emptyFold,
  foldFile,
  foldLine,
  isPendingFold,
  saveFold,
  segmentFile,
  segmentsIn
} from './fightSegments';

const gzip = promisify(zlib.gzip);
const OLD_LOG = /^(.+)\.jsonl\.gz$/;
/** Where a character's segments are built before they take the record's place, and back. */
const STAGING = {
  name: (id: string): string => `.${id}.segmenting`,
  id: (name: string): string | undefined => /^\.(.+)\.segmenting$/.exec(name)?.[1]
};

/**
 * Every old log under `fightsDir`, split into `perSegment` fights a segment.
 * Never rejects: a character whose log cannot be split is said and left as it
 * was, to be tried again next launch.
 */
export async function segmentFightLogs(
  fightsDir: string,
  perSegment: number,
  note: (message: string) => void
): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(fightsDir);
  } catch (error) {
    // No fight log yet is nothing to split; anything else is said.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      note(t('notices.fights.unreadable', { dir: fightsDir, error: errorMessage(error) }));
    }
    return;
  }
  const ids = new Set<string>();
  for (const name of names) {
    const id = OLD_LOG.exec(name)?.[1];
    if (id !== undefined) ids.add(id);
    // Segments built by a run that stopped after the old file went.
    const built = STAGING.id(name);
    if (built !== undefined) ids.add(built);
  }
  for (const id of [...ids].sort()) {
    const old = path.join(fightsDir, `${id}.jsonl.gz`);
    try {
      await segmentOne(fightsDir, id, perSegment, note);
    } catch (error) {
      note(t('notices.migration.fightsNotSegmented', { file: old, error: errorMessage(error) }));
    }
  }
}

async function segmentOne(
  fightsDir: string,
  id: string,
  perSegment: number,
  note: (message: string) => void
): Promise<void> {
  const old = path.join(fightsDir, `${id}.jsonl.gz`);
  const built = path.join(fightsDir, STAGING.name(id));
  const target = path.join(fightsDir, id);
  if (fs.existsSync(old)) {
    const backup = await backUp(old);
    await fs.promises.rm(built, { recursive: true, force: true });
    await fs.promises.mkdir(built, { recursive: true });
    const split = await writeSegments(old, built, perSegment);
    // The segments are complete: from here a stopped run only has to place them.
    await fs.promises.unlink(old);
    await place(built, target);
    const params = {
      file: old,
      dir: target,
      segments: split.segments,
      per: perSegment,
      fights: split.fights,
      backup
    };
    note(
      split.segments === 1
        ? t('notices.migration.fightsSegmented.one', params)
        : t('notices.migration.fightsSegmented.many', params)
    );
    if (split.skipped > 0) {
      const skipped = { file: old, count: split.skipped, backup };
      note(
        split.skipped === 1
          ? t('notices.migration.fightsSkipped.one', skipped)
          : t('notices.migration.fightsSkipped.many', skipped)
      );
    }
    if (split.damaged) {
      note(t('notices.migration.fightsDamaged', { file: old, fights: split.fights, backup }));
    }
    return;
  }
  await place(built, target);
}

/**
 * Copies the old log aside, unless an earlier run already did. A copy of
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
 * Streams the old log into segments under `dir`, folding as it goes so each
 * full segment's fold is written beside it; the last is left open. A damaged
 * stream keeps every fight read before the damage, the way `readFights` keeps
 * the members before a truncated one.
 */
async function writeSegments(
  old: string,
  dir: string,
  perSegment: number
): Promise<{ segments: number; fights: number; skipped: number; damaged: boolean }> {
  let segment = 1;
  let fights = 0;
  let skipped = 0;
  let lines: string[] = [];
  let folded = emptyFold();
  const take = (line: string): void => {
    if (line.trim().length === 0) return;
    if (foldLine(folded, line)) lines.push(line);
    else skipped += 1;
  };
  const flush = async (full: boolean): Promise<void> => {
    const bytes = await gzip(Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8'));
    await fs.promises.writeFile(segmentFile(dir, segment), bytes);
    if (full) await saveFold(dir, segment, folded, bytes.length);
    fights += lines.length;
    lines = [];
    folded = emptyFold();
    segment += 1;
  };

  const input = fs.createReadStream(old);
  const gunzip = zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
  input.on('error', (error) => gunzip.destroy(error));
  input.pipe(gunzip);
  let carry = Buffer.alloc(0);
  let damaged = false;
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      let text = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      for (let end = text.indexOf(10); end !== -1; end = text.indexOf(10)) {
        take(text.subarray(0, end).toString('utf8'));
        text = text.subarray(end + 1);
        if (lines.length >= perSegment) await flush(true);
      }
      carry = Buffer.from(text);
    }
  } catch (error) {
    // Damage inside the gzip data costs what follows it; anything else (a
    // read that failed) leaves the old file for the next launch.
    if (!isZlibError(error)) throw error;
    damaged = true;
  } finally {
    input.destroy();
  }
  take(carry.toString('utf8'));
  if (lines.length > 0) await flush(false);
  return { segments: segment - 1, fights, skipped, damaged };
}

function isZlibError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code.startsWith('Z_');
}

/**
 * Puts the built segments where the record lives. Segments already there were
 * written after the old file (by a quit while the split was running), so they
 * go after it, renumbered, each fold moved before its segment so a stopped
 * move resumes in order.
 */
async function place(built: string, target: string): Promise<void> {
  if (!fs.existsSync(built)) return;
  if (fs.existsSync(target)) {
    let next = (segmentsIn(built).at(-1) ?? 0) + 1;
    for (const segment of segmentsIn(target)) {
      if (fs.existsSync(foldFile(target, segment))) {
        await fs.promises.rename(foldFile(target, segment), foldFile(built, next));
      }
      await fs.promises.rename(segmentFile(target, segment), segmentFile(built, next));
      next += 1;
    }
    for (const entry of await fs.promises.readdir(target)) {
      if (isPendingFold(entry)) await fs.promises.rm(path.join(target, entry), { force: true });
    }
    // Only empty: anything else in it is not the fight log's, and stops the move.
    await fs.promises.rmdir(target);
  }
  await fs.promises.rename(built, target);
}
