/**
 * The peer gateway's wire (todo 20261031-1156-01): registration over HTTP, as
 * the art server's, then one WebSocket per install carrying JSON frames each
 * way. Every frame off the wire is read here into its type or null. A
 * character is claimed by proving it holds that character's key (an Ed25519
 * key pair made on the sharer's install, the user's answer of 2026-11-02);
 * the gateway pins the key to the name, and each side of a share keeps the
 * other's key so a remade character of the same name gets nothing. See
 * `mudengine-session` › *Peers*.
 */
import { asPeerKey, isPeerName, SHARE_LEVELS, type PeerKey, type ShareLevel } from './peers';
import { asTopPatch, type RpcPatch } from './rpc';
import { everyOf, isRecord, memberOf } from './values';

/** Where each half lives on the gateway. */
export const PEER_PATHS = {
  challenge: '/v1/challenge',
  register: '/v1/register',
  stream: '/v1/stream'
} as const;

/** The build's HMAC over the registration challenge, as the art server's `X-Art-Build`. */
export const PEER_BUILD_HEADER = 'x-peer-build';

/** `GET /v1/challenge`: the proof of work to do (`node/proofOfWork.ts`). */
export interface PeerChallenge {
  challenge: string;
  bits: number;
}

/** `POST /v1/register`'s body. */
export interface PeerRegistration {
  challenge: string;
  nonce: string;
}

/** What registering gives an install: a name for it, and the secret its hellos are signed with. */
export interface PeerToken {
  token: string;
  secret: string;
}

const CHALLENGE = /^[0-9a-f]{64}$/;
const TOKEN = /^[0-9a-f]{24}$/;
const SECRET = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;
const POW_NONCE = /^[0-9]{1,20}$/;
/** An Ed25519 public key, its 32 bytes as base64url. */
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
/** An Ed25519 signature, its 64 bytes as base64url. */
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const HMAC = /^[0-9a-f]{64}$/;

export function asPeerChallenge(value: unknown): PeerChallenge | null {
  if (!isRecord(value)) return null;
  const { challenge, bits } = value;
  if (typeof challenge !== 'string' || !CHALLENGE.test(challenge)) return null;
  if (typeof bits !== 'number' || !Number.isInteger(bits) || bits < 0 || bits > 64) return null;
  return { challenge, bits };
}

export function asPeerRegistration(value: unknown): PeerRegistration | null {
  if (!isRecord(value)) return null;
  const { challenge, nonce } = value;
  if (typeof challenge !== 'string' || !CHALLENGE.test(challenge)) return null;
  if (typeof nonce !== 'string' || !POW_NONCE.test(nonce)) return null;
  return { challenge, nonce };
}

export function asPeerToken(value: unknown): PeerToken | null {
  if (!isRecord(value)) return null;
  const { token, secret } = value;
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  if (typeof secret !== 'string' || !SECRET.test(secret)) return null;
  return { token, secret };
}

/** Whether a value is an HMAC-SHA256 as hex, the shape of the build header and a hello's `sig`. */
export function isPeerHmac(value: unknown): value is string {
  return typeof value === 'string' && HMAC.test(value);
}

/** What an install's hello signs with its secret (HMAC-SHA256, hex); `time` is in whole seconds. */
export function helloText(time: number, nonce: string): string {
  return `mudengine-peer-hello\n${time}\n${nonce}`;
}

/** What a character's key signs to answer the gateway's challenge for it. */
export function claimText(peer: PeerKey, nonce: string): string {
  return `mudengine-peer-claim\n${peer.realm}\n${peer.name}\n${nonce}`;
}

/**
 * Whether `signature` is `key`'s over `text`. The port the gateway checks an
 * answer through; `node/ed25519.ts` is the one implementation.
 */
export type ChecksSignature = (key: string, text: string, signature: string) => boolean;

/** A name a sharer lists, the level it gives, and the receiver's key once seen (else null). */
export interface ShareEntry {
  name: string;
  share: Exclude<ShareLevel, 'off'>;
  key: string | null;
}

/** A name and the key that holds it, as the gateway tells a sharer who is listening. */
export interface Listener {
  name: string;
  key: string;
}

/** The sheet's own patch, the fields `RpcPatch` carries. */
export type SheetPatch = Pick<RpcPatch, 'set' | 'deep' | 'drop'>;

/** Install to gateway. */
export type PeerUp =
  | { k: 'hello'; token: string; time: number; nonce: string; sig: string }
  | { k: 'claim'; peer: PeerKey; key: string }
  | { k: 'answer'; peer: PeerKey; sig: string }
  | { k: 'shares'; peer: PeerKey; to: ShareEntry[] }
  | { k: 'sheet'; peer: PeerKey; sheet: Record<string, unknown> }
  | ({ k: 'patch'; peer: PeerKey } & SheetPatch)
  | { k: 'leave'; peer: PeerKey };

/**
 * Why a claim was refused: another key holds the name, the answer did not
 * verify, the install claims too many, or the gateway holds all the names it may.
 */
export type UnclaimedWhy = 'held' | 'answer' | 'too-many' | 'full';
export const UNCLAIMED_WHYS: readonly UnclaimedWhy[] = ['held', 'answer', 'too-many', 'full'];

/** Why a sharer's sheet stopped: the sharer logged off, or no longer shares with this install. */
export type GoneWhy = 'left' | 'unshared';
export const GONE_WHYS: readonly GoneWhy[] = ['left', 'unshared'];

/** Why a frame was refused. `REFUSALS_THAT_CLOSE` end the socket as well. */
export type RefusedWhy =
  | 'unknown-token'
  | 'signature'
  | 'replaced'
  | 'over-limit'
  | 'malformed'
  | 'not-claimed'
  | 'no-sheet';
export const REFUSED_WHYS: readonly RefusedWhy[] = [
  'unknown-token',
  'signature',
  'replaced',
  'over-limit',
  'malformed',
  'not-claimed',
  'no-sheet'
];

/** The refusals that close the socket: the install is not who it says, or is not keeping to the wire. */
export const REFUSALS_THAT_CLOSE: ReadonlySet<RefusedWhy> = new Set([
  'unknown-token',
  'signature',
  'replaced',
  'over-limit',
  'malformed'
]);

/** Gateway to install. */
export type PeerDown =
  | { k: 'welcome' }
  | { k: 'refused'; why: RefusedWhy }
  | { k: 'challenge'; peer: PeerKey; nonce: string }
  | { k: 'claimed'; peer: PeerKey }
  | { k: 'unclaimed'; peer: PeerKey; why: UnclaimedWhy }
  | { k: 'audience'; peer: PeerKey; to: Listener[] }
  | { k: 'unshared'; peer: PeerKey; name: string; why: 'another-key' }
  | { k: 'shared'; from: PeerKey; key: string; to: string[] }
  | { k: 'sheet'; from: PeerKey; sheet: Record<string, unknown> }
  | ({ k: 'patch'; from: PeerKey } & SheetPatch)
  | { k: 'gone'; from: PeerKey; why: GoneWhy };

/** The most names one share list or audience may carry. */
export const MOST_SHARE_NAMES = 32;

function asShareEntry(value: unknown): ShareEntry | null {
  if (!isRecord(value)) return null;
  const { name, key } = value;
  const share = memberOf(value['share'], SHARE_LEVELS);
  if (!isPeerName(name) || share === null || share === 'off') return null;
  if (key !== null && !isPublicKey(key)) return null;
  return { name, share, key };
}

function asListener(value: unknown): Listener | null {
  if (!isRecord(value)) return null;
  const { name, key } = value;
  return isPeerName(name) && isPublicKey(key) ? { name, key } : null;
}

const listOf = <T>(value: unknown, item: (each: unknown) => T | null): T[] | null =>
  everyOf(value, item, MOST_SHARE_NAMES);

export function isPublicKey(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_KEY.test(value);
}

/** An install's frame, or null for anything that does not read as one. */
export function asPeerUp(value: unknown): PeerUp | null {
  if (!isRecord(value)) return null;
  const k = value['k'];
  if (k === 'hello') {
    const { token, time, nonce, sig } = value;
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    if (typeof time !== 'number' || !Number.isInteger(time)) return null;
    if (typeof nonce !== 'string' || !NONCE.test(nonce) || !isPeerHmac(sig)) return null;
    return { k, token, time, nonce, sig };
  }
  const peer = asPeerKey(value['peer']);
  if (peer === null) return null;
  switch (k) {
    case 'claim':
      return isPublicKey(value['key']) ? { k, peer, key: value['key'] } : null;
    case 'answer': {
      const sig = value['sig'];
      return typeof sig === 'string' && SIGNATURE.test(sig) ? { k, peer, sig } : null;
    }
    case 'shares': {
      const to = listOf(value['to'], asShareEntry);
      return to === null ? null : { k, peer, to };
    }
    case 'sheet':
      return isRecord(value['sheet']) ? { k, peer, sheet: value['sheet'] } : null;
    case 'patch': {
      const fields = asTopPatch(value);
      return fields === null ? null : { k, peer, ...fields };
    }
    case 'leave':
      return { k, peer };
    default:
      return null;
  }
}

/** The gateway's frame, or null for anything that does not read as one. */
export function asPeerDown(value: unknown): PeerDown | null {
  if (!isRecord(value)) return null;
  const k = value['k'];
  if (k === 'welcome') return { k };
  if (k === 'refused') {
    const why = memberOf(value['why'], REFUSED_WHYS);
    return why === null ? null : { k, why };
  }
  if (k === 'challenge' || k === 'claimed' || k === 'unclaimed' || k === 'audience') {
    const peer = asPeerKey(value['peer']);
    if (peer === null) return null;
    if (k === 'claimed') return { k, peer };
    if (k === 'challenge') {
      const nonce = value['nonce'];
      return typeof nonce === 'string' && CHALLENGE.test(nonce) ? { k, peer, nonce } : null;
    }
    if (k === 'unclaimed') {
      const why = memberOf(value['why'], UNCLAIMED_WHYS);
      return why === null ? null : { k, peer, why };
    }
    const to = listOf(value['to'], asListener);
    return to === null ? null : { k, peer, to };
  }
  if (k === 'unshared') {
    const peer = asPeerKey(value['peer']);
    const name = value['name'];
    if (peer === null || !isPeerName(name) || value['why'] !== 'another-key') return null;
    return { k, peer, name, why: 'another-key' };
  }
  const from = asPeerKey(value['from']);
  if (from === null) return null;
  switch (k) {
    case 'shared': {
      const key = value['key'];
      const to = listOf(value['to'], (each) => (isPeerName(each) ? each : null));
      return isPublicKey(key) && to !== null ? { k, from, key, to } : null;
    }
    case 'sheet':
      return isRecord(value['sheet']) ? { k, from, sheet: value['sheet'] } : null;
    case 'patch': {
      const fields = asTopPatch(value);
      return fields === null ? null : { k, from, ...fields };
    }
    case 'gone': {
      const why = memberOf(value['why'], GONE_WHYS);
      return why === null ? null : { k, from, why };
    }
    default:
      return null;
  }
}
