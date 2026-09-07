/**
 * Who may open the client in a browser.
 *
 * The desktop client is gated by the machine it runs on. Served over HTTP it
 * is gated by this: one password, resolved once at startup, and a session
 * token the browser carries in a cookie once it has given the password. The
 * socket that carries the game, the character state **and the settings
 * screen** — which writes the player's realm password — is served to nobody
 * else.
 *
 * Three sources for the password, in order, and the order is the point
 * (kept from the noVNC image this replaced):
 *
 * 1. `MUDENGINE_PASSWORD` — an explicit instruction from whoever started
 *    the client, and it wins outright.
 * 2. What a previous start generated, saved `0600` beside the options file,
 *    so a restart does not invalidate a password somebody already saved.
 * 3. A fresh one, generated here and **printed once**, by the start that made
 *    it. A restart says where it is and does not reprint it: a password
 *    reprinted every start is a password in every run's logs, which is what
 *    `npm run check:secrets` exists to find.
 *
 * The comparison is constant-time and over a digest, so a wrong password of
 * the wrong length takes as long to refuse as one of the right length.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Where a generated password is kept, under the client's home. */
export const PASSWORD_FILE = '.access-password';

/** The cookie a signed-in browser carries. */
export const COOKIE = 'mudengine_session';

export type PasswordSource = 'env' | 'saved' | 'generated';

export interface AccessPassword {
  password: string;
  source: PasswordSource;
  /** Where a saved or generated one lives, so the banner can say. */
  file: string;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A password of `length` letters and digits, drawn without modulo bias: a
 * byte is used only when it is below the largest multiple of the alphabet
 * (248 = 62 × 4), and drawn again otherwise. The shell version this replaced
 * filtered a base64 string down, which produced a *shorter* password whenever
 * the draw happened to contain the characters it removed.
 */
export function generatePassword(length: number): string {
  const limit = ALPHABET.length * Math.floor(256 / ALPHABET.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export function resolveAccessPassword(
  env: NodeJS.ProcessEnv,
  home: string,
  generate: () => string = () => generatePassword(24)
): AccessPassword {
  const file = path.join(home, PASSWORD_FILE);
  const fromEnv = env['MUDENGINE_PASSWORD'] ?? '';
  if (fromEnv.length > 0) return { password: fromEnv, source: 'env', file };

  let saved: string | null = null;
  try {
    saved = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  } catch (error) {
    // Absent is the first start. Anything else — unreadable, a directory —
    // is a file that exists and cannot be used, and writing over it would
    // be the client deciding a password somebody saved does not count.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (saved !== null && saved.length > 0) return { password: saved, source: 'saved', file };

  const password = generate();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, password, { encoding: 'utf8', mode: 0o600 });
  return { password, source: 'generated', file };
}

/** Constant-time, over digests, so length says nothing. */
export function passwordMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * The tokens issued this run. In memory on purpose: a restart is a new
 * sign-in, and a token that outlived the process would be one more secret
 * on disk beside the password.
 */
export class AccessTokens {
  private readonly issued = new Set<string>();

  issue(): string {
    const token = randomBytes(32).toString('hex');
    this.issued.add(token);
    return token;
  }

  has(token: string | null | undefined): boolean {
    return typeof token === 'string' && this.issued.has(token);
  }

  revoke(token: string): void {
    this.issued.delete(token);
  }
}

/** The session token out of a `Cookie` header, or null. */
export function cookieToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() !== COOKIE) continue;
    const value = part.slice(at + 1).trim();
    return /^[0-9a-f]{64}$/.test(value) ? value : null;
  }
  return null;
}

/**
 * The password out of an `Authorization: Basic` header, or null.
 *
 * The user name is ignored: there is one password and no accounts, and a
 * script or a proxy that sends `anything:password` is signed in. The colon
 * splits at the *first* one, so a password containing one survives.
 */
export function basicPassword(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!match) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1] ?? '', 'base64').toString('utf8');
  } catch {
    return null;
  }
  const at = decoded.indexOf(':');
  if (at === -1) return null;
  return decoded.slice(at + 1);
}
