/**
 * Pictures the art server drew, on disk (todo 20261019-0931-01): each under
 * the hash it was asked by (a portrait's facts, a room's description), the
 * newest `kept`, one store per kind; and per character the hash of its last
 * portrait, so a restart shows it at once and asks nothing while the facts
 * stay the same.
 */
import fs from 'node:fs';
import path from 'node:path';

import { errorMessage, isRecord } from '../../shared/values';
import { writeWhole } from '../app/writeWhole';

export interface Picture {
  bytes: Uint8Array;
  type: 'image/webp' | 'image/png';
}

const EXTENSIONS = { 'image/webp': '.webp', 'image/png': '.png' } as const;

/** The picture as a window loads it. */
export function dataUrlOf(picture: Picture): string {
  return `data:${picture.type};base64,${Buffer.from(picture.bytes).toString('base64')}`;
}
const HASH = /^[0-9a-f]{32}$/;

export class PictureCache {
  constructor(
    private readonly dir: string,
    private readonly kept: () => number
  ) {}

  async get(hash: string): Promise<Picture | null> {
    for (const [type, extension] of Object.entries(EXTENSIONS) as [Picture['type'], string][]) {
      try {
        const bytes = await fs.promises.readFile(path.join(this.dir, hash + extension));
        return { bytes: new Uint8Array(bytes), type };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`a kept picture could not be read: ${errorMessage(error)}`);
        }
      }
    }
    return null;
  }

  async put(hash: string, picture: Picture): Promise<void> {
    await writeWhole(path.join(this.dir, hash + EXTENSIONS[picture.type]), picture.bytes);
    await this.trim();
  }

  /** The oldest past the count go, by when each was written. */
  private async trim(): Promise<void> {
    const names = (await fs.promises.readdir(this.dir)).filter((name) =>
      Object.values(EXTENSIONS).some((extension) => name.endsWith(extension))
    );
    const excess = names.length - this.kept();
    if (excess <= 0) return;
    const dated = await Promise.all(
      names.map(async (name) => ({
        name,
        at: (await fs.promises.stat(path.join(this.dir, name))).mtimeMs
      }))
    );
    dated.sort((a, b) => a.at - b.at);
    await Promise.all(
      dated
        .slice(0, excess)
        .map(({ name }) => fs.promises.rm(path.join(this.dir, name), { force: true }))
    );
  }
}

/** One character's last portrait, `{ "hash": … }` in its record. */
export interface LastPortrait {
  read(): Promise<string | null>;
  write(hash: string): Promise<void>;
}

export function lastPortraitAt(file: string): LastPortrait {
  return {
    async read() {
      try {
        const json: unknown = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        return isRecord(json) && typeof json['hash'] === 'string' && HASH.test(json['hash'])
          ? json['hash']
          : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        // A record that does not parse names no portrait; the next one drawn rewrites it.
        if (error instanceof SyntaxError) return null;
        throw new Error(`${file} could not be read: ${errorMessage(error)}`);
      }
    },
    async write(hash) {
      await writeWhole(file, JSON.stringify({ hash }));
    }
  };
}
