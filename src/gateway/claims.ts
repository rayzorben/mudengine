/**
 * A claim as the gateway holds it: a name, the key that proved it, and the
 * socket it came on. The router and the control routes both key by it.
 */
import type { PeerKey } from '../shared/peers';
import type { PeerDown } from '../shared/peerWire';

/** An install's socket, as the router sends to it. */
export interface InstallLine {
  send(frame: PeerDown): void;
}

export interface Claim {
  readonly peer: PeerKey;
  readonly key: string;
  readonly line: InstallLine;
  /** The name's `peerKeyText`. */
  readonly name: string;
}

/** One claim's id: the name and the key that proved it. */
export const claimId = (name: string, key: string): string => `${name}\u0000${key}`;
