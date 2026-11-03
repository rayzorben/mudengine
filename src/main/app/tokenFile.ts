/**
 * A token and secret a service gave this install at registration, the art
 * server's (`art/artToken.ts`) and the sharing gateway's (`peers/wiring.ts`),
 * kept in a file under the home readable by this user only, as the web host
 * keeps its password (`host/web/access.ts`). Written whole through a
 * temporary file; a file that does not read through the service's own reader
 * is no token, and the next request registers again.
 */
import fs from 'node:fs';

import { errorMessage } from '../../shared/values';
import { writeWhole } from './writeWhole';

export interface TokenFile<T> {
  read(): Promise<T | null>;
  write(token: T): Promise<void>;
  forget(): Promise<void>;
}

export function tokensAt<T>(file: string, reader: (value: unknown) => T | null): TokenFile<T> {
  return {
    async read() {
      let text: string;
      try {
        text = await fs.promises.readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error(`${file} could not be read: ${errorMessage(error)}`);
      }
      try {
        return reader(JSON.parse(text));
      } catch {
        return null;
      }
    },
    async write(token) {
      await writeWhole(file, JSON.stringify(token), 0o600);
    },
    async forget() {
      await fs.promises.rm(file, { force: true });
    }
  };
}
