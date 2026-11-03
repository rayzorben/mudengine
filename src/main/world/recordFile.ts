/**
 * Reading one realm's record file back: the envelope (`version`, `realm`, an
 * array of rows), the rows the caller checks, and what a damaged file costs.
 * Shared by `DescriptionBook`, `ShopBook` and `FloorBook`; `FindBook` reads its
 * own, since it upgrades older versions in place.
 */
import fs from 'node:fs';
import path from 'node:path';

import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';

export interface RecordFileShape<T> {
  version: number;
  /** The envelope's field holding the rows. */
  field: string;
  /**
   * The rows to keep, or null to refuse the whole file. A store that skips a
   * row it cannot read filters here instead of refusing.
   */
  rows: (rows: unknown[]) => T[] | null;
  /** The store's own notices, as literal keys so `i18n-coverage` sees them. */
  invalid: (fileName: string) => string;
  readError: (fileName: string, message: string) => string;
}

/**
 * The rows kept in `file` for `realm`; none for a missing file, another
 * realm's file or a damaged one. A damaged file, one that is not JSON
 * included, is reported and kept aside (`keepDamaged`); a read the disk
 * refused is reported and the file left alone.
 */
export function readRecordFile<T>(
  file: string,
  realm: string,
  shape: RecordFileShape<T>,
  onError?: (message: string) => void
): T[] {
  const fileName = path.basename(file);
  try {
    if (!fs.existsSync(file)) return [];
    const read: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const envelope =
      typeof read === 'object' && read !== null ? (read as Record<string, unknown>) : null;
    const field = envelope?.[shape.field];
    const rows =
      envelope !== null &&
      envelope['version'] === shape.version &&
      typeof envelope['realm'] === 'string' &&
      Array.isArray(field)
        ? shape.rows(field as unknown[])
        : null;
    if (envelope === null || rows === null) {
      onError?.(shape.invalid(fileName));
      keepDamaged(file, onError);
      return [];
    }
    return envelope['realm'] === realm ? rows : [];
  } catch (error) {
    onError?.(shape.readError(fileName, errorMessage(error)));
    keepUnparsed(file, error, onError);
    return [];
  }
}

/**
 * Copies a damaged record file aside, since the store's next write replaces
 * it, and says where. A copy already holding the same bytes is the answer, so
 * loading one damaged file again copies nothing; otherwise the first free name
 * of `.bak`, `.2.bak`, … is taken, so an earlier copy (an upgrade's, or another
 * damaged file's) is never written over. `oldRecordSplit.ts`'s `backUp` is the
 * asynchronous one, for a migration. Never throws: a copy that fails is said,
 * and the load goes on.
 */
export function keepDamaged(file: string, say?: (message: string) => void): void {
  const fileName = path.basename(file);
  const kept = (backup: string): void =>
    say?.(t('notices.world.records.keptAside', { fileName, backup: path.basename(backup) }));
  try {
    const damaged = fs.readFileSync(file);
    for (let n = 1; ; n += 1) {
      const backup = n === 1 ? `${file}.bak` : `${file}.${n}.bak`;
      let held: Buffer;
      try {
        held = fs.readFileSync(backup);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EISDIR') continue;
        if (code !== 'ENOENT') throw error;
        fs.writeFileSync(backup, damaged, { flag: 'wx' });
        kept(backup);
        return;
      }
      if (held.equals(damaged)) {
        kept(backup);
        return;
      }
    }
  } catch (error) {
    say?.(t('notices.world.records.notKeptAside', { fileName, message: errorMessage(error) }));
  }
}

/**
 * `keepDamaged` for a read that failed in `JSON.parse`: the file was read and
 * is damaged. Any other failure is the disk's, and the file is left alone.
 */
export function keepUnparsed(file: string, error: unknown, say?: (message: string) => void): void {
  if (error instanceof SyntaxError) keepDamaged(file, say);
}

/** Every row, or null when any is not one: the whole-file refusal. */
export function everyRow<T>(check: (value: unknown) => value is T) {
  return (rows: unknown[]): T[] | null => (rows.every(check) ? rows : null);
}
