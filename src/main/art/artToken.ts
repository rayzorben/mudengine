/**
 * The token and secret the art server gave this install at registration
 * (todo 20261019-0931-01), kept in `<home>/.art-token` readable by this user
 * only, as the web host keeps its password (`host/web/access.ts`). Written
 * whole through a temporary file; a file that does not parse is no token, and
 * the next request registers again.
 */
import fs from 'node:fs';

import { errorMessage, isRecord } from '../../shared/values';
import { writeWhole } from '../app/writeWhole';

export interface ArtToken {
  token: string;
  secret: string;
}

export const ART_TOKEN_FILE = '.art-token';

const TOKEN_ID = /^[0-9a-f]{24}$/;

/** The gateway's register answer or the kept file, or null for anything else. */
export function asArtToken(value: unknown): ArtToken | null {
  if (!isRecord(value)) return null;
  const { token, secret } = value;
  if (typeof token !== 'string' || !TOKEN_ID.test(token)) return null;
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 128) return null;
  return { token, secret };
}

export interface ArtTokens {
  read(): Promise<ArtToken | null>;
  write(token: ArtToken): Promise<void>;
  forget(): Promise<void>;
}

export function artTokensAt(file: string): ArtTokens {
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
        return asArtToken(JSON.parse(text));
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
