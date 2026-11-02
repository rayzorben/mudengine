/**
 * Reading one realm's record file back: the envelope (`version`, `realm`, an
 * array of rows), the rows the caller checks, and what a damaged file costs.
 * Shared by `DescriptionBook`, `ShopBook` and `FloorBook`; `FindBook` reads its
 * own, since it upgrades older versions in place.
 */
import fs from 'node:fs';
import path from 'node:path';

import { errorMessage } from '../../shared/values';

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
 * realm's file or a damaged one. A damaged file is copied to `.bak` once,
 * since the next write replaces it, and reported; a read that throws is
 * reported and the file left alone.
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
      if (!fs.existsSync(`${file}.bak`)) fs.copyFileSync(file, `${file}.bak`);
      onError?.(shape.invalid(fileName));
      return [];
    }
    return envelope['realm'] === realm ? rows : [];
  } catch (error) {
    onError?.(shape.readError(fileName, errorMessage(error)));
    return [];
  }
}

/** Every row, or null when any is not one: the whole-file refusal. */
export function everyRow<T>(check: (value: unknown) => value is T) {
  return (rows: unknown[]): T[] | null => (rows.every(check) ? rows : null);
}
