/**
 * The art server's settings (todo 20261019-0931-01): whether the character
 * panel asks it for this character's portrait, whether the game view sends a
 * room the bundled set has no picture for (todo 20261020-2015-01), and where
 * it is. Used by the whole install, and copied into no realm or character.
 * Beside `config.ts`, which composes it into `AppConfig`.
 */
import { bool, isRecord } from './values';

export interface ArtConfig {
  /** Ask the art server for this character's portrait. */
  enabled: boolean;
  /**
   * Send a room the bundled set has no picture for: its map and room
   * numbers, its name and its description as printed, nothing about the
   * character. On, as portraits are (todo 20261020-2015-01).
   */
  rooms: boolean;
  /** The server's address, `https://` (`http://` only on this machine). */
  server: string;
}

export const DEFAULT_ART: ArtConfig = {
  enabled: true,
  rooms: true,
  server: 'https://art.150-136-117-176.sslip.io'
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The address without a trailing slash, or null for anything else: a portrait
 * request is signed, but what it says about the character is not for a plain
 * `http://` hop across the internet.
 */
export function asArtServer(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const secure =
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!secure || url.search !== '' || url.hash !== '' || url.username !== '') return null;
  return url.href.replace(/\/+$/, '');
}

export function normalizeArt(raw: unknown): ArtConfig {
  const block = isRecord(raw) ? raw : {};
  return {
    enabled: bool(block['enabled'], DEFAULT_ART.enabled),
    rooms: bool(block['rooms'], DEFAULT_ART.rooms),
    server: asArtServer(block['server']) ?? DEFAULT_ART.server
  };
}
