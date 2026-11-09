/**
 * A file a tab sends from the viewer's own machine, written to `uploads/`
 * under the home. The player in a browser sits at another machine than the
 * client's, so every file-in point (a card layout, a world database, a
 * character) offers this beside the home listing; the stored file is under
 * the home, so `Host.chosenPath` accepts it as picked.
 *
 * Streamed to disk with a cap, never held whole: a world database runs to
 * tens of megabytes. Past the cap, or on an aborted request, the partial
 * file is removed. Reasoning in `mudengine-session` › `parts/hosts.md`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { errorMessage } from '../../../shared/values';
import { claimFileIn } from './claim';

export type StoredUpload =
  | { kind: 'stored'; file: string }
  | { kind: 'too-large' }
  | { kind: 'bad-name' }
  | { kind: 'failed'; reason: string };

/** The longest file name kept; the extension is what matters to the reader. */
const MAX_NAME = 120;

/**
 * The viewer's file name, reduced to one safe component: no directory, no
 * leading dot, nothing a shell or another filesystem would read differently.
 * Null when nothing of it is left.
 */
export function uploadName(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const safe = base
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  if (safe.length === 0) return null;
  if (safe.length <= MAX_NAME) return safe;
  const extension = path.extname(safe).slice(0, 16);
  return safe.slice(0, MAX_NAME - extension.length) + extension;
}

/** Raised inside the pipeline past the cap, so the pipeline tears both ends down. */
class TooLarge extends Error {}

export async function storeUpload(
  dir: string,
  rawName: string,
  source: Readable,
  most: number
): Promise<StoredUpload> {
  const name = uploadName(rawName);
  if (name === null) return { kind: 'bad-name' };
  let file: string | null = null;
  let size = 0;
  try {
    file = await claimFileIn(dir, name);
    await pipeline(
      source,
      async function* capped(chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          size += chunk.length;
          if (size > most) throw new TooLarge();
          yield chunk;
        }
      },
      fs.createWriteStream(file)
    );
    return { kind: 'stored', file };
  } catch (error) {
    // The partial file goes whatever stopped it; the request itself is the caller's.
    if (file !== null) await fs.promises.rm(file, { force: true });
    return error instanceof TooLarge
      ? { kind: 'too-large' }
      : { kind: 'failed', reason: errorMessage(error) };
  }
}
