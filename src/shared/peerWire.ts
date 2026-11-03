/**
 * The peer gateway's wire (todo 20261031-1156-01): registration over HTTP, as
 * the art server's, then one WebSocket per install carrying JSON frames each
 * way. Every frame off the wire is read here into its type or null. A
 * character is claimed by proving it holds the key it presents (an Ed25519
 * key pair made per character on each install). The gateway never refuses a
 * name because another key claimed it: the same player plays one character
 * from two installs. The key is pinned by the share (the user's answer of
 * 2026-11-02): a share entry names the receiver keys the sharer granted, a
 * receiver is told the sharer's key, and a key the grant does not name is
 * sent nothing. A key nobody has pinned is unknown, so it is reported to the
 * sharer to pin (`unpinned`) and sent nothing until it is. See
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

/**
 * The largest frame either side sends, a whole sheet included. The gateway
 * refuses a larger one, and an install dialling it reads up to it.
 */
export const PEER_MAX_MESSAGE_BYTES = 65_536;

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

/**
 * A name a sharer lists, the level it gives, and the receiver keys the grant
 * holds: one for each of that player's installs. Only a claim under one of
 * them is sent the sheet; an entry with none sends nobody anything.
 */
export interface ShareEntry {
  name: string;
  share: Exclude<ShareLevel, 'off'>;
  keys: string[];
}

/** The most receiver keys one share entry may pin. */
export const MOST_SHARE_KEYS = 8;

/** A name and a key that holds it, as the gateway tells a sharer who is listening. */
export interface Listener {
  name: string;
  key: string;
}

/** Whether two listeners are one claim: the same name under the same key. */
export const sameListener = (a: Listener, b: Listener): boolean =>
  a.name === b.name && a.key === b.key;

/** The sheet's own patch, the fields `RpcPatch` carries. */
export type SheetPatch = Pick<RpcPatch, 'set' | 'deep' | 'drop'>;

/**
 * The longest run of terminal text one frame carries. The game sends 338 B/s
 * on average and 8.8 KB in its busiest second (the todo's
 * `terminal-bytes.mjs`); a backlog goes in frames of this size.
 */
export const PEER_MOST_TEXT = 16_384;

/** The largest action or answer one frame carries: a line typed and a name or two. */
const MOST_CONTROL_BYTES = 4096;

/** Which action a controller sent, so the sharer's answer finds it. */
const MOST_ACTION_ID = 2 ** 31;

/**
 * Install to gateway. The control frames (`peerControl.ts`): a controller's
 * `watch` and `act` name the sharer by its claim and key; a sharer's `text`,
 * `acted` and `release` name the controller as a `Listener`. The gateway
 * relays `action` and `answer` without reading them.
 */
export type PeerUp =
  | { k: 'hello'; token: string; time: number; nonce: string; sig: string }
  | { k: 'claim'; peer: PeerKey; key: string }
  | { k: 'answer'; peer: PeerKey; sig: string }
  | { k: 'shares'; peer: PeerKey; to: ShareEntry[] }
  | { k: 'sheet'; peer: PeerKey; sheet: Record<string, unknown> }
  | ({ k: 'patch'; peer: PeerKey } & SheetPatch)
  | { k: 'leave'; peer: PeerKey }
  | { k: 'watch'; peer: PeerKey; from: PeerKey; key: string; on: boolean }
  | {
      k: 'act';
      peer: PeerKey;
      from: PeerKey;
      key: string;
      id: number;
      action: Record<string, unknown>;
    }
  /** Terminal text to every controller, or to `to` alone (the backlog a new one is sent). */
  | { k: 'text'; peer: PeerKey; text: string; to: Listener | null }
  | { k: 'acted'; peer: PeerKey; to: Listener; id: number; answer: Record<string, unknown> }
  | { k: 'release'; peer: PeerKey; to: Listener };

/** Every kind of install frame, so a kind another build added is told from a frame that does not read. */
export const PEER_UP_KINDS: readonly PeerUp['k'][] = [
  'hello',
  'claim',
  'answer',
  'shares',
  'sheet',
  'patch',
  'leave',
  'watch',
  'act',
  'text',
  'acted',
  'release'
];

/** Whether `value` is a frame of a kind this build does not know, as a newer build would send. */
export function isUnknownKind(value: unknown, known: readonly string[]): boolean {
  return isRecord(value) && typeof value['k'] === 'string' && !known.includes(value['k']);
}

/** Why a claim was refused: the answer did not verify, or the install claims too many. */
export type UnclaimedWhy = 'answer' | 'too-many';
export const UNCLAIMED_WHYS: readonly UnclaimedWhy[] = ['answer', 'too-many'];

/**
 * Why remote control ended: the sharer pressed Stop, no longer gives this
 * character control, or logged off.
 */
export type ReleasedWhy = 'stopped' | 'unshared' | 'left';
export const RELEASED_WHYS: readonly ReleasedWhy[] = ['stopped', 'unshared', 'left'];

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
  | 'no-sheet'
  | 'not-shared'
  | 'unknown-frame';
export const REFUSED_WHYS: readonly RefusedWhy[] = [
  'unknown-token',
  'signature',
  'replaced',
  'over-limit',
  'malformed',
  'not-claimed',
  'no-sheet',
  'not-shared',
  'unknown-frame'
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
  /** A claim of a listed name under a key the grant does not hold, for the player to pin or not. */
  | { k: 'unpinned'; peer: PeerKey; name: string; key: string }
  /** The names `from` shares with on this install, and those of them it gives remote control. */
  | { k: 'shared'; from: PeerKey; key: string; to: string[]; control: string[] }
  | { k: 'sheet'; from: PeerKey; key: string; sheet: Record<string, unknown> }
  | ({ k: 'patch'; from: PeerKey; key: string } & SheetPatch)
  | { k: 'gone'; from: PeerKey; key: string; why: GoneWhy }
  /** Who is watching `peer`'s terminal and may send it actions. */
  | { k: 'controllers'; peer: PeerKey; to: Listener[] }
  | { k: 'act'; peer: PeerKey; by: Listener; id: number; action: Record<string, unknown> }
  | { k: 'text'; from: PeerKey; key: string; text: string }
  | { k: 'acted'; from: PeerKey; key: string; id: number; answer: Record<string, unknown> }
  | { k: 'released'; from: PeerKey; key: string; why: ReleasedWhy };

/** Every kind of gateway frame (`isUnknownKind`). */
export const PEER_DOWN_KINDS: readonly PeerDown['k'][] = [
  'welcome',
  'refused',
  'challenge',
  'claimed',
  'unclaimed',
  'audience',
  'unpinned',
  'shared',
  'sheet',
  'patch',
  'gone',
  'controllers',
  'act',
  'text',
  'acted',
  'released'
];

/** The most names one share list may carry. */
export const MOST_SHARE_NAMES = 32;
/** The most listeners one audience may carry: every key of every name. */
const MOST_LISTENERS = MOST_SHARE_NAMES * MOST_SHARE_KEYS;

function asShareEntry(value: unknown): ShareEntry | null {
  if (!isRecord(value)) return null;
  const { name } = value;
  const share = memberOf(value['share'], SHARE_LEVELS);
  if (!isPeerName(name) || share === null || share === 'off') return null;
  const keys = everyOf(value['keys'], (each) => (isPublicKey(each) ? each : null), MOST_SHARE_KEYS);
  return keys === null ? null : { name, share, keys };
}

function asListener(value: unknown): Listener | null {
  if (!isRecord(value)) return null;
  const { name, key } = value;
  return isPeerName(name) && isPublicKey(key) ? { name, key } : null;
}

const listOf = <T>(value: unknown, item: (each: unknown) => T | null): T[] | null =>
  everyOf(value, item, MOST_SHARE_NAMES);

/**
 * A share list read entry by entry: one that does not read (a level another
 * build added) is not shared, and the rest still are. Null only for no list.
 */
function shareEntries(value: unknown): ShareEntry[] | null {
  if (!Array.isArray(value) || value.length > MOST_SHARE_NAMES) return null;
  return value.map(asShareEntry).filter((each): each is ShareEntry => each !== null);
}

const isActionId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MOST_ACTION_ID;

/** An action or an answer, relayed unread: a record, bounded. */
function controlBody(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return JSON.stringify(value).length <= MOST_CONTROL_BYTES ? value : null;
}

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= PEER_MOST_TEXT;

/** The control frames an install sends, each read whole or not at all. */
function asControlUp(
  k: unknown,
  peer: PeerKey,
  value: Readonly<Record<string, unknown>>
): PeerUp | null {
  switch (k) {
    case 'watch':
    case 'act': {
      const from = asPeerKey(value['from']);
      const key = value['key'];
      if (from === null || !isPublicKey(key)) return null;
      if (k === 'watch') {
        const on = value['on'];
        return typeof on === 'boolean' ? { k, peer, from, key, on } : null;
      }
      const action = controlBody(value['action']);
      const id = value['id'];
      return action !== null && isActionId(id) ? { k, peer, from, key, id, action } : null;
    }
    case 'text': {
      const text = value['text'];
      const named = value['to'] ?? null;
      const to = named === null ? null : asListener(named);
      if (!isText(text) || (named !== null && to === null)) return null;
      return { k, peer, text, to };
    }
    case 'acted':
    case 'release': {
      const to = asListener(value['to']);
      if (to === null) return null;
      if (k === 'release') return { k, peer, to };
      const answer = controlBody(value['answer']);
      const id = value['id'];
      return answer !== null && isActionId(id) ? { k, peer, to, id, answer } : null;
    }
    default:
      return null;
  }
}

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
      const to = shareEntries(value['to']);
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
      return asControlUp(k, peer, value);
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
  if (k === 'controllers' || k === 'act') {
    const peer = asPeerKey(value['peer']);
    if (peer === null) return null;
    if (k === 'controllers') {
      const to = everyOf(value['to'], asListener, MOST_LISTENERS);
      return to === null ? null : { k, peer, to };
    }
    const by = asListener(value['by']);
    const action = controlBody(value['action']);
    const id = value['id'];
    return by !== null && action !== null && isActionId(id) ? { k, peer, by, id, action } : null;
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
    const to = everyOf(value['to'], asListener, MOST_LISTENERS);
    return to === null ? null : { k, peer, to };
  }
  const key = value['key'];
  if (!isPublicKey(key)) return null;
  if (k === 'unpinned') {
    const peer = asPeerKey(value['peer']);
    const name = value['name'];
    return peer === null || !isPeerName(name) ? null : { k, peer, name, key };
  }
  const from = asPeerKey(value['from']);
  if (from === null) return null;
  switch (k) {
    case 'shared': {
      const name = (each: unknown): string | null => (isPeerName(each) ? each : null);
      const to = listOf(value['to'], name);
      // A gateway from before remote control sends no `control`: none is given.
      const control = value['control'] === undefined ? [] : listOf(value['control'], name);
      return to === null || control === null ? null : { k, from, key, to, control };
    }
    case 'sheet':
      return isRecord(value['sheet']) ? { k, from, key, sheet: value['sheet'] } : null;
    case 'patch': {
      const fields = asTopPatch(value);
      return fields === null ? null : { k, from, key, ...fields };
    }
    case 'gone': {
      const why = memberOf(value['why'], GONE_WHYS);
      return why === null ? null : { k, from, key, why };
    }
    case 'text': {
      const text = value['text'];
      return isText(text) ? { k, from, key, text } : null;
    }
    case 'acted': {
      const answer = controlBody(value['answer']);
      const id = value['id'];
      return answer !== null && isActionId(id) ? { k, from, key, id, answer } : null;
    }
    case 'released': {
      const why = memberOf(value['why'], RELEASED_WHYS);
      return why === null ? null : { k, from, key, why };
    }
    default:
      return null;
  }
}
