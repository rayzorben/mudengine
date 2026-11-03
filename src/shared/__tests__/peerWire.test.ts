import { describe, expect, it } from 'vitest';

import {
  asPeerChallenge,
  asPeerDown,
  asPeerRegistration,
  asPeerToken,
  asPeerUp,
  isUnknownKind,
  MOST_SHARE_KEYS,
  MOST_SHARE_NAMES,
  PEER_DOWN_KINDS,
  PEER_UP_KINDS,
  type PeerDown,
  type PeerUp
} from '../peerWire';

const peer = { realm: 'orohost:2427/GreaterMUD', name: 'Brakkle' };
const soul = { realm: 'orohost:2427/GreaterMUD', name: 'Soul' };
const key = 'A'.repeat(43);
const hex = (length: number): string => 'a'.repeat(length);

const ups: PeerUp[] = [
  { k: 'hello', token: hex(24), time: 1_700_000_000, nonce: hex(32), sig: hex(64) },
  { k: 'claim', peer, key },
  { k: 'answer', peer, sig: 'B'.repeat(86) },
  { k: 'shares', peer, to: [{ name: 'Soul', share: 'state', keys: [] }] },
  { k: 'sheet', peer, sheet: { v: 1 } },
  { k: 'patch', peer, set: { level: 13 }, deep: {}, drop: [] },
  { k: 'leave', peer },
  { k: 'watch', peer, from: soul, key, on: true },
  { k: 'act', peer, from: soul, key, id: 7, action: { v: 1, a: 'move', dir: 'n' } },
  { k: 'text', peer, text: 'You are in the plaza.\r\n', to: null },
  { k: 'text', peer, text: 'backlog', to: { name: 'Soul', key } },
  { k: 'acted', peer, to: { name: 'Soul', key }, id: 7, answer: { r: 'done' } },
  { k: 'release', peer, to: { name: 'Soul', key } }
];

const downs: PeerDown[] = [
  { k: 'welcome' },
  { k: 'refused', why: 'not-claimed' },
  { k: 'challenge', peer, nonce: hex(64) },
  { k: 'claimed', peer },
  { k: 'unclaimed', peer, why: 'answer' },
  { k: 'audience', peer, to: [{ name: 'Soul', key }] },
  { k: 'unpinned', peer, name: 'Soul', key },
  { k: 'shared', from: peer, key, to: ['Soul'], control: ['Soul'] },
  { k: 'sheet', from: peer, key, sheet: { v: 1 } },
  {
    k: 'patch',
    from: peer,
    key,
    set: {},
    deep: { vitals: { k: 'fields', set: { hp: 3 }, deep: {}, drop: [] } },
    drop: []
  },
  { k: 'gone', from: peer, key, why: 'left' },
  { k: 'controllers', peer, to: [{ name: 'Soul', key }] },
  { k: 'act', peer, by: { name: 'Soul', key }, id: 7, action: { v: 1, a: 'rest' } },
  { k: 'text', from: peer, key, text: 'You are in the plaza.' },
  { k: 'acted', from: peer, key, id: 7, answer: { r: 'refused', why: 'not now' } },
  { k: 'released', from: peer, key, why: 'stopped' }
];

const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('the peer wire', () => {
  it('reads every frame each way as it was written', () => {
    for (const frame of ups) expect(asPeerUp(wire(frame))).toEqual(frame);
    for (const frame of downs) expect(asPeerDown(wire(frame))).toEqual(frame);
  });

  it('refuses a frame of a kind it does not know, or with no peer', () => {
    expect(asPeerUp({ k: 'control', peer })).toBeNull();
    expect(asPeerUp({ k: 'claim', key })).toBeNull();
    expect(asPeerDown({ k: 'gone', from: peer, why: 'bored' })).toBeNull();
  });

  it('shares nothing at off, at a level another build added, or to a padded name', () => {
    const shares = (to: unknown): unknown => ({ k: 'shares', peer, to });
    const soulAt = { name: 'Soul', share: 'state', keys: [] };
    const none = { k: 'shares', peer, to: [] };
    expect(asPeerUp(shares([{ name: 'Soul', share: 'off', keys: [] }]))).toEqual(none);
    expect(asPeerUp(shares([{ name: 'Soul ', share: 'state', keys: [] }]))).toEqual(none);
    // The entry that does not read is not shared; the one beside it still is.
    expect(asPeerUp(shares([{ name: 'Rand', share: 'drive', keys: [] }, soulAt]))).toEqual({
      ...none,
      to: [soulAt]
    });
  });

  it('refuses a share list past its bound, and shares nothing past a bound on keys', () => {
    const shares = (to: unknown): unknown => ({ k: 'shares', peer, to });
    const many = Array.from({ length: MOST_SHARE_NAMES + 1 }, (_, i) => ({
      name: `P${i}`,
      share: 'state',
      keys: []
    }));
    expect(asPeerUp(shares(many))).toBeNull();
    expect(asPeerUp(shares(many.slice(1)))).not.toBeNull();
    const pinned = (count: number): unknown =>
      shares([{ name: 'Soul', share: 'state', keys: Array.from({ length: count }, () => key) }]);
    expect(asPeerUp(pinned(MOST_SHARE_KEYS))).not.toBeNull();
    expect(asPeerUp(pinned(MOST_SHARE_KEYS + 1))).toEqual({ k: 'shares', peer, to: [] });
    const short = shares([{ name: 'Soul', share: 'state', keys: ['short'] }]);
    expect(asPeerUp(short)).toEqual({ k: 'shares', peer, to: [] });
  });

  it('reads a frame from a gateway or build that lacks a field, and ignores one it does not know', () => {
    // A gateway from before remote control says no `control`: nobody is given it.
    expect(asPeerDown({ k: 'shared', from: peer, key, to: ['Soul'] })).toEqual({
      k: 'shared',
      from: peer,
      key,
      to: ['Soul'],
      control: []
    });
    expect(asPeerDown({ k: 'released', from: peer, key, why: 'stopped', extra: 1 })).toEqual({
      k: 'released',
      from: peer,
      key,
      why: 'stopped'
    });
    // An action or answer is relayed unread, so a field another build adds crosses whole.
    const act = { k: 'act', peer, from: soul, key, id: 1, action: { v: 2, a: 'dance' } };
    expect(asPeerUp(act)).toEqual(act);
    expect(asPeerUp({ ...act, id: -1 })).toBeNull();
    expect(asPeerUp({ ...act, action: { text: 'x'.repeat(5000) } })).toBeNull();
    expect(asPeerUp({ k: 'text', peer, text: '', to: null })).toBeNull();
  });

  it('tells a kind another build added from a frame that does not read', () => {
    expect(isUnknownKind({ k: 'dance', peer }, PEER_UP_KINDS)).toBe(true);
    expect(isUnknownKind({ k: 'claim', peer }, PEER_UP_KINDS)).toBe(false);
    expect(isUnknownKind({ peer }, PEER_UP_KINDS)).toBe(false);
    expect(isUnknownKind({ k: 'dance' }, PEER_DOWN_KINDS)).toBe(true);
    // Every kind each way is listed: a frame of each reads.
    expect(new Set(ups.map((frame) => frame.k))).toEqual(new Set(PEER_UP_KINDS));
    expect(new Set(downs.map((frame) => frame.k))).toEqual(new Set(PEER_DOWN_KINDS));
  });

  it('refuses a key or a signature of the wrong length', () => {
    expect(asPeerUp({ k: 'claim', peer, key: key.slice(1) })).toBeNull();
    expect(asPeerUp({ k: 'answer', peer, sig: 'B'.repeat(85) })).toBeNull();
  });

  it('reads the registration shapes, and nothing else as them', () => {
    expect(asPeerChallenge({ challenge: hex(64), bits: 20 })).toEqual({
      challenge: hex(64),
      bits: 20
    });
    expect(asPeerChallenge({ challenge: hex(63), bits: 20 })).toBeNull();
    expect(asPeerRegistration({ challenge: hex(64), nonce: '123' })).not.toBeNull();
    expect(asPeerRegistration({ challenge: hex(64), nonce: '-1' })).toBeNull();
    expect(asPeerToken({ token: hex(24), secret: hex(64) })).not.toBeNull();
    expect(asPeerToken({ token: hex(24), secret: 'short' })).toBeNull();
  });
});
