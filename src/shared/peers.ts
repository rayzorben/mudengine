/**
 * Characters shared through the peer gateway (todo 20261031-1156-01): a
 * player picks, per character and by name, who sees it. The sharer's client
 * streams a `PeerSheet` as what changed (`RpcPatch`'s fields, rebuilt with
 * `applyPatch`), and a receiver reads it field by field through `asPeerSheet`.
 * A share never leaves its realm: the key holds the realm, and the gateway
 * routes within one realm only. The frames are `peerWire.ts`. See
 * `mudengine-session` › *Peers*.
 */
import {
  AFFLICTION_STATES,
  STEALTH_STATES,
  type ActiveBuff,
  type Affliction,
  type Afflictions,
  type RoomCandidate,
  type Stealth,
  type Vitals
} from './character';
import { playerKey } from './players';
import { everyOf, isRecord, memberOf, oneOf } from './values';

/**
 * A character as the realm confirms it: `realmName` (address and chosen
 * realm) and the in-game name. Profile ids and server names are labels on
 * one machine and never cross.
 */
export interface PeerKey {
  readonly realm: string;
  readonly name: string;
}

/** The key as a map key: names compare without case, as the server's do. */
export function peerKeyText(key: PeerKey): string {
  return `${key.realm}\u0000${playerKey(key.name)}`;
}

/**
 * What a player gives another, on that player's row. Remote control is a
 * third level once the user settles how it works across two builds (open
 * question 2 of the todo); until then a share is the sheet or nothing.
 */
export type ShareLevel = 'off' | 'state';
export const SHARE_LEVELS: readonly ShareLevel[] = ['off', 'state'];

/** The sheet's own version, raised when a field changes meaning. A new field does not raise it. */
export const PEER_SHEET_VERSION = 1;

/**
 * What a sharer streams. Its own record, not `CharacterState`, because two
 * players' installs run different builds and a stranger's state is read
 * field by field, never cast. A field an older sender lacks reads as `null`.
 */
export interface PeerSheet {
  readonly v: number;
  readonly className: string | null;
  readonly vitals: Vitals | null;
  readonly afflictions: Afflictions | null;
  readonly buffs: readonly ActiveBuff[] | null;
  readonly inCombat: boolean | null;
  readonly stealth: Stealth | null;
  readonly level: number | null;
  readonly exp: number | null;
  readonly expNeeded: number | null;
  readonly room: PeerRoom | null;
  readonly leader: string | null;
}

export interface PeerRoom {
  readonly map: number | null;
  readonly number: number | null;
  readonly name: string | null;
  readonly candidates: readonly RoomCandidate[];
}

/** Bounds on size only: the realm's own name rules are the server's to apply. */
const MOST_REALM = 200;
const MOST_NAME = 40;
/** The longest class, spell, room or leader name a sheet carries. */
const MOST_TEXT = 120;
/** More buffs or room candidates than this is not a character's sheet. */
const MOST_ITEMS = 64;

/** A key off the wire, or null for anything else. */
export function asPeerKey(value: unknown): PeerKey | null {
  if (!isRecord(value)) return null;
  const { realm, name } = value;
  if (typeof realm !== 'string' || realm.length === 0 || realm.length > MOST_REALM) return null;
  if (!isPeerName(name)) return null;
  return { realm, name };
}

/** An in-game name as a key or a share list holds it: bounded, and never padded. */
export function isPeerName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MOST_NAME &&
    value.trim() === value
  );
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= MOST_TEXT ? value : null;
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const listOf = <T>(value: unknown, item: (each: unknown) => T | null): T[] | null =>
  everyOf(value, item, MOST_ITEMS);

/**
 * Each member read alone: a number or null where the sender knew none, and a
 * record a member of which is the wrong type is no vitals at all, since a
 * maximum read wrong is a heal sent at the wrong time.
 */
function asVitals(value: unknown): Vitals | null {
  if (!isRecord(value)) return null;
  const figure = (member: unknown): number | null | undefined =>
    member === null || member === undefined ? null : (count(member) ?? undefined);
  const hp = figure(value['hp']);
  const mana = figure(value['mana']);
  const hpMax = figure(value['hpMax']);
  const manaMax = figure(value['manaMax']);
  const manaType = value['manaType'] ?? null;
  const resting = flag(value['resting'] ?? false);
  const meditating = flag(value['meditating'] ?? false);
  if (hp === undefined || mana === undefined || hpMax === undefined || manaMax === undefined) {
    return null;
  }
  if (manaType !== null && manaType !== 'MA' && manaType !== 'KAI') return null;
  if (resting === null || meditating === null) return null;
  return { hp, mana, manaType, hpMax, manaMax, resting, meditating };
}

/** Each condition alone; one a sender's build lacks, or sends wrong, is `unknown`. */
function asAfflictions(value: unknown): Afflictions | null {
  if (!isRecord(value)) return null;
  const read = (member: unknown): Affliction => oneOf(member, AFFLICTION_STATES, 'unknown');
  return {
    blind: read(value['blind']),
    poisoned: read(value['poisoned']),
    diseased: read(value['diseased']),
    held: read(value['held']),
    confused: read(value['confused']),
    afraid: read(value['afraid'])
  };
}

function asBuff(value: unknown): ActiveBuff | null {
  if (!isRecord(value)) return null;
  const spell = text(value['spell']);
  const by = value['by'] === null ? null : text(value['by']);
  const appliedAt = count(value['appliedAt']);
  if (spell === null || appliedAt === null || (value['by'] !== null && by === null)) return null;
  const expiresAt = value['expiresAt'] === undefined ? undefined : count(value['expiresAt']);
  const candidates =
    value['candidates'] === undefined ? undefined : listOf(value['candidates'], text);
  if (expiresAt === null || candidates === null) return null;
  return {
    spell,
    by,
    appliedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(candidates === undefined ? {} : { candidates })
  };
}

function asCandidate(value: unknown): RoomCandidate | null {
  if (!isRecord(value)) return null;
  const map = count(value['map']);
  const room = count(value['room']);
  const name = text(value['name']);
  const chosen = flag(value['chosen']);
  if (map === null || room === null || name === null || chosen === null) return null;
  return { map, room, name, chosen };
}

function asRoom(value: unknown): PeerRoom | null {
  if (!isRecord(value)) return null;
  const candidates = listOf(value['candidates'] ?? [], asCandidate);
  if (candidates === null) return null;
  return {
    map: count(value['map']),
    number: count(value['number']),
    name: text(value['name']),
    candidates
  };
}

/**
 * A sheet off the gateway, read field by field: a field an older build does
 * not send, or sends as the wrong type, is `null` alone, and a field this
 * build does not know is ignored. Null for anything that is not a sheet, or
 * one whose version says its fields mean something this build does not.
 */
export function asPeerSheet(value: unknown): PeerSheet | null {
  if (!isRecord(value)) return null;
  const v = value['v'];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > PEER_SHEET_VERSION) {
    return null;
  }
  return {
    v,
    className: text(value['className']),
    vitals: asVitals(value['vitals']),
    afflictions: asAfflictions(value['afflictions']),
    buffs: listOf(value['buffs'], asBuff),
    inCombat: flag(value['inCombat']),
    stealth: memberOf(value['stealth'], STEALTH_STATES),
    level: count(value['level']),
    exp: count(value['exp']),
    expNeeded: count(value['expNeeded']),
    room: asRoom(value['room']),
    leader: text(value['leader'])
  };
}

/** A key offered for this player to pin: a claim of a name, or a share from it. */
export interface KeyOffer {
  readonly name: string;
  readonly key: string;
}

/** A sheet another player's character shares with this one, as its player accepted it. */
export interface SharedSheet {
  readonly from: PeerKey;
  readonly key: string;
  readonly sheet: PeerSheet;
  readonly heardAt: number;
}

/** Whether the gateway's socket is open, being dialled, or not wanted. */
export type ShareLink = 'off' | 'connecting' | 'connected';

/** What one character's window is shown of sharing (`Push.shares`). */
export interface ShareView {
  readonly link: ShareLink;
  /** This character's own key on its realm, for the other player to compare; null until a share needs one. */
  readonly ownKey: string | null;
  /** Claims of names this character shares with, under keys its player has not pinned. */
  readonly unpinned: readonly KeyOffer[];
  /** Shares this character takes from a name, under keys its player has not pinned. */
  readonly offered: readonly KeyOffer[];
  readonly sheets: readonly SharedSheet[];
}

export const NO_SHARES: ShareView = {
  link: 'off',
  ownKey: null,
  unpinned: [],
  offered: [],
  sheets: []
};
