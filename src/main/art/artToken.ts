/**
 * The token and secret the art server gave this install at registration
 * (todo 20261019-0931-01), kept in `<home>/.art-token` (`app/tokenFile.ts`).
 */
import { isRecord } from '../../shared/values';
import { tokensAt, type TokenFile } from '../app/tokenFile';

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

export type ArtTokens = TokenFile<ArtToken>;

export function artTokensAt(file: string): ArtTokens {
  return tokensAt(file, asArtToken);
}
