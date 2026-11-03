/**
 * The peer gateway's settings (todo 20261031-1156-01): whether this install
 * shares characters through it at all, and where it is. Off by default, the
 * user's answer of 2026-11-02: nothing goes to the gateway unless this is on
 * and a player's row shares with them or receives from them; a row that only
 * receives sends the character's name and key, never its sheet. Used by the
 * whole install, and copied into no realm or character. Beside `config.ts`,
 * which composes it into `AppConfig`.
 */
import { asServiceAddress } from './serviceAddress';
import { bool, isRecord } from './values';

export interface PeersConfig {
  /** Share and receive characters through the gateway. */
  enabled: boolean;
  /** The gateway's address, `https://` (`http://` only on this machine). */
  server: string;
}

export const DEFAULT_PEERS: PeersConfig = {
  enabled: false,
  server: 'https://peers.150-136-117-176.sslip.io'
};

export function normalizePeers(raw: unknown): PeersConfig {
  const block = isRecord(raw) ? raw : {};
  return {
    enabled: bool(block['enabled'], DEFAULT_PEERS.enabled),
    server: asServiceAddress(block['server']) ?? DEFAULT_PEERS.server
  };
}
