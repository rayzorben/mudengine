/** A file written whole through a temporary beside it, so a reader never sees half of it. */
import fs from 'node:fs';
import path from 'node:path';

export async function writeWhole(
  file: string,
  data: string | Uint8Array,
  mode?: number
): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(temporary, data, mode === undefined ? {} : { mode });
    await fs.promises.rename(temporary, file);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}
