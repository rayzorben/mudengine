import type { AppConfig } from './config';

/**
 * Which passwords this client knows, and whether a text holds one.
 *
 * One home for the question `npm run check:secrets` asks of the files on disk
 * and the bug report asks of itself before it is written (todo 75). A password
 * shorter than this is skipped by both: two characters match half of any
 * session log, and a check that always fires is a check nobody reads.
 */
export const SECRET_MIN_LENGTH = 4;

/** A configured password and whose file it is in, said by name, never by value. */
export interface Secret {
  owner: string;
  value: string;
}

/** A configuration and the name a player knows it by (a character, or the options file). */
export interface Account {
  owner: string;
  config: AppConfig;
}

/** Every distinct password the given configurations hold, long enough to look for. */
export function configuredSecrets(accounts: readonly Account[]): Secret[] {
  const out = new Map<string, Secret>();
  for (const { owner, config } of accounts) {
    const value = config.connection.login.password;
    if (value.length >= SECRET_MIN_LENGTH && !out.has(value)) out.set(value, { owner, value });
  }
  return [...out.values()];
}

/** The first of `secrets` that appears in `text`, or null. */
export function secretIn(text: string, secrets: readonly Secret[]): Secret | null {
  return secrets.find((secret) => text.includes(secret.value)) ?? null;
}
