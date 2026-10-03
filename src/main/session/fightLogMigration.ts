/**
 * Splits each character's old one-file fight log, `fights/<id>.jsonl.gz`, into
 * the segments of `fightSegments.ts`, once, at startup, and says so; the
 * backup, the staging and the resume are `oldRecordSplit.ts`.
 * Streamed, so a log too large for one string still splits. `mudengine-world` › *Every
 * fight is written down before anybody asks* has the reasons.
 */
import fs from 'node:fs';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';
import {
  FIGHTS_EXT,
  emptyFold,
  foldFile,
  foldLine,
  isPendingFold,
  saveFold,
  segmentFile
} from './fightSegments';
import { splitOldRecords } from './oldRecordSplit';

const gzip = promisify(zlib.gzip);

/**
 * Every old log under `fightsDir`, split into `perSegment` fights a segment.
 * Never rejects: a character whose log cannot be split is said and left as it
 * was, to be tried again next launch.
 */
export function segmentFightLogs(
  fightsDir: string,
  perSegment: number,
  note: (message: string) => void
): Promise<void> {
  return splitOldRecords({
    dir: fightsDir,
    ext: FIGHTS_EXT,
    split: (old, built) => writeSegments(old, built, perSegment),
    companion: foldFile,
    leftover: isPendingFold,
    done: ({ old, target, backup, result: split }) => {
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
    },
    failed: (old, error) =>
      note(t('notices.migration.fightsNotSegmented', { file: old, error: errorMessage(error) })),
    unreadable: (dir, error) =>
      note(t('notices.fights.unreadable', { dir, error: errorMessage(error) }))
  });
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
