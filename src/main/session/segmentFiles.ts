/**
 * Where a character's record kept as numbered segments in a directory of its
 * own (`0001<ext>`, `0002<ext>`, …) has each one. The fight log and the
 * backscroll are both kept this way; what goes into a segment is theirs.
 * `oldRecordSplit.ts` makes such a directory from an old one-file record.
 */
import fs from 'node:fs';
import path from 'node:path';

const name = (segment: number): string => String(segment).padStart(4, '0');

/** Where one segment is. */
export const segmentPath = (dir: string, segment: number, ext: string): string =>
  path.join(dir, `${name(segment)}${ext}`);

/** A segment's own number in a file name: `0012<ext>` is 12, anything else none. */
const numberOf = (entry: string, ext: string): number | undefined => {
  if (!entry.endsWith(ext)) return undefined;
  const digits = entry.slice(0, entry.length - ext.length);
  return /^\d{4,}$/.test(digits) ? Number(digits) : undefined;
};

/** The segment numbers in `dir`, in order; none for a directory that is not there. */
export function segmentsIn(dir: string, ext: string): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return numbersIn(names, ext);
}

/** {@link segmentsIn} off the thread. */
export async function segmentsInAsync(dir: string, ext: string): Promise<number[]> {
  try {
    return numbersIn(await fs.promises.readdir(dir), ext);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Not there, or a file where a directory on the way should be: no record. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function numbersIn(names: readonly string[], ext: string): number[] {
  return names
    .map((entry) => numberOf(entry, ext))
    .filter((segment): segment is number => segment !== undefined)
    .sort((a, b) => a - b);
}
