/**
 * The sharing half of a player's row (`RemoteGrant`, todo 20261031-1156-01):
 * what this character shares with that player, whether this character takes
 * what that player shares, and the keys pinned as that player's character.
 * A key is pinned only by this player's own press, after the gateway reports
 * it (`unpinned`, or a share offered under it), so a key the gateway saw
 * claimed is never trusted by itself. One reader for the options file, a
 * draft and a window's payload. See `mudengine-session` › *Peers*.
 */
import { MOST_SHARE_KEYS, isPublicKey } from './peerWire';
import { SHARE_LEVELS, type ShareLevel } from './peers';
import { everyOf, memberOf } from './values';

export interface PeerGrant {
  /** What this character shares with them. */
  share: ShareLevel;
  /** Show and act on what they share with this character. */
  receive: boolean;
  /** Their character's keys, one per install they play it from, pinned by this player. */
  keys: string[];
}

export const NO_PEER_GRANT: PeerGrant = { share: 'off', receive: false, keys: [] };

/** Whether the row says nothing about sharing. */
export function peerGrantIsEmpty(grant: PeerGrant): boolean {
  return grant.share === 'off' && !grant.receive && grant.keys.length === 0;
}

/**
 * The sharing fields of a row, each absent one off; null where one is there
 * and is not what it should be, so a window's payload is refused whole.
 */
export function asPeerGrant(row: Readonly<Record<string, unknown>>): PeerGrant | null {
  const share = row['share'] === undefined ? 'off' : memberOf(row['share'], SHARE_LEVELS);
  const receive = row['receive'] ?? false;
  const keys =
    row['keys'] === undefined
      ? []
      : everyOf(row['keys'], (each) => (isPublicKey(each) ? each : null), MOST_SHARE_KEYS);
  if (share === null || typeof receive !== 'boolean' || keys === null) return null;
  return { share, receive, keys: [...new Set(keys)] };
}

/** The row as written to a file: only what is not off, as `allowAll` is written. */
export function writtenPeerGrant(grant: PeerGrant): Partial<PeerGrant> {
  return {
    ...(grant.share === 'off' ? {} : { share: grant.share }),
    ...(grant.receive ? { receive: true } : {}),
    ...(grant.keys.length === 0 ? {} : { keys: [...grant.keys] })
  };
}

/** `grant` with `key` pinned, or as it was when it is pinned already or the row is full. */
export function withPinnedKey(grant: PeerGrant, key: string): PeerGrant {
  if (grant.keys.includes(key) || grant.keys.length >= MOST_SHARE_KEYS) return grant;
  return { ...grant, keys: [...grant.keys, key] };
}
