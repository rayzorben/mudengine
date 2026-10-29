/**
 * Append to a log that starts afresh as `<file>.1` once past `limit` bytes,
 * so one generation is kept and the volume does not fill: `stalls.log` had
 * reached 43 MB on the host with nothing ever trimming it (2026-10-29 UTC).
 */
import fs from 'node:fs';
import path from 'node:path';

export async function appendRotating(file: string, text: string, limit: number): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const size = await fs.promises.stat(file).then(
    (info) => info.size,
    () => 0
  );
  if (size > limit) {
    // Two writers past the limit together: the second finds the first's rename done.
    await fs.promises.rename(file, `${file}.1`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  await fs.promises.appendFile(file, text, 'utf8');
}
