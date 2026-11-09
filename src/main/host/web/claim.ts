/**
 * A fresh file in a directory of the home, for what a tab saves (`exports/`)
 * and what a tab uploads (`uploads/`). Neither ever overwrites a file the
 * player already has there.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * `dir/name`, or `stem-2.ext`, `stem-3.ext`… when that is taken. Created empty
 * here (`wx`), so two saves at once cannot be handed the same name.
 */
export async function claimFileIn(dir: string, name: string): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  const dot = name.indexOf('.');
  const stem = dot === -1 ? name : name.slice(0, dot);
  const extension = dot === -1 ? '' : name.slice(dot);
  for (let n = 1; ; n += 1) {
    const file = path.join(dir, n === 1 ? name : `${stem}-${n}${extension}`);
    try {
      await fs.promises.writeFile(file, '', { flag: 'wx' });
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}
