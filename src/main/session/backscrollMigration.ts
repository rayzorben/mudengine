/**
 * Splits each character's old one-file backscroll, `backscroll/<id>.log`, into
 * the segments `Backscroll` keeps, once, at startup, and says so; the backup,
 * the staging and the resume are `oldRecordSplit.ts`. Streamed, so
 * the old file is never one string. `mudengine-session` › *The backscroll
 * outlives the process* has the reasons.
 */
import fs from 'node:fs';

import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';
import { BACKSCROLL_EXT } from './Backscroll';
import { splitOldRecords } from './oldRecordSplit';
import { segmentPath } from './segmentFiles';

/**
 * Every old backscroll under `dir`, split into segments of `perSegment` lines.
 * Never rejects: a file that cannot be split is said and left as it was, to be
 * tried again next launch.
 */
export function segmentBackscrolls(
  dir: string,
  perSegment: number,
  note: (message: string) => void
): Promise<void> {
  const per = Math.max(1, Math.floor(perSegment));
  return splitOldRecords({
    dir,
    ext: BACKSCROLL_EXT,
    split: (old, built) => writeSegments(old, built, per),
    done: ({ old, target, backup, result }) => {
      const params = { file: old, dir: target, segments: result, per, backup };
      note(
        result <= 1
          ? t('notices.migration.backscrollSegmented.one', params)
          : t('notices.migration.backscrollSegmented.many', params)
      );
    },
    failed: (old, error) =>
      note(
        t('notices.migration.backscrollNotSegmented', { file: old, error: errorMessage(error) })
      ),
    unreadable: (path, error) =>
      note(t('notices.migration.backscrollUnreadable', { dir: path, error: errorMessage(error) }))
  });
}

/**
 * Streams the old file into segments of `per` lines each, every one ending on
 * a newline so no escape sequence is cut; the last holds the rest and whatever
 * followed the last newline. Returns how many were written. Bytes are cut at
 * `\n`, which never occurs inside a UTF-8 sequence.
 */
async function writeSegments(old: string, dir: string, per: number): Promise<number> {
  let segment = 1;
  let lines = 0;
  let parts: Buffer[] = [];
  const flush = async (): Promise<void> => {
    await fs.promises.writeFile(segmentPath(dir, segment, BACKSCROLL_EXT), Buffer.concat(parts));
    parts = [];
    lines = 0;
    segment += 1;
  };
  const input = fs.createReadStream(old);
  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      let from = 0;
      for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, at + 1)) {
        lines += 1;
        if (lines < per) continue;
        parts.push(chunk.subarray(from, at + 1));
        from = at + 1;
        await flush();
      }
      if (from < chunk.length) parts.push(chunk.subarray(from));
    }
  } finally {
    input.destroy();
  }
  if (parts.length > 0) await flush();
  return segment - 1;
}
