import { describe, expect, it } from 'vitest';

import {
  asPeerChallenge,
  asPeerDown,
  asPeerRegistration,
  asPeerToken,
  asPeerUp,
  MOST_SHARE_NAMES,
  type PeerDown,
  type PeerUp
} from '../peerWire';

const peer = { realm: 'orohost:2427/GreaterMUD', name: 'Brakkle' };
const key = 'A'.repeat(43);
const hex = (length: number): string => 'a'.repeat(length);

const ups: PeerUp[] = [
  { k: 'hello', token: hex(24), time: 1_700_000_000, nonce: hex(32), sig: hex(64) },
  { k: 'claim', peer, key },
  { k: 'answer', peer, sig: 'B'.repeat(86) },
  { k: 'shares', peer, to: [{ name: 'Soul', share: 'state', key: null }] },
  { k: 'sheet', peer, sheet: { v: 1 } },
  { k: 'patch', peer, set: { level: 13 }, deep: {}, drop: [] },
  { k: 'leave', peer }
];

const downs: PeerDown[] = [
  { k: 'welcome' },
  { k: 'refused', why: 'not-claimed' },
  { k: 'challenge', peer, nonce: hex(64) },
  { k: 'claimed', peer },
  { k: 'unclaimed', peer, why: 'held' },
  { k: 'audience', peer, to: [{ name: 'Soul', key }] },
  { k: 'unshared', peer, name: 'Soul', why: 'another-key' },
  { k: 'shared', from: peer, key, to: ['Soul'] },
  { k: 'sheet', from: peer, sheet: { v: 1 } },
  {
    k: 'patch',
    from: peer,
    set: {},
    deep: { vitals: { k: 'fields', set: { hp: 3 }, deep: {}, drop: [] } },
    drop: []
  },
  { k: 'gone', from: peer, why: 'left' }
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

  it('refuses a share at off, a padded name, and a list past its bound', () => {
    const shares = (to: unknown): unknown => ({ k: 'shares', peer, to });
    expect(asPeerUp(shares([{ name: 'Soul', share: 'off', key: null }]))).toBeNull();
    expect(asPeerUp(shares([{ name: 'Soul ', share: 'state', key: null }]))).toBeNull();
    const many = Array.from({ length: MOST_SHARE_NAMES + 1 }, (_, i) => ({
      name: `P${i}`,
      share: 'state',
      key: null
    }));
    expect(asPeerUp(shares(many))).toBeNull();
    expect(asPeerUp(shares(many.slice(1)))).not.toBeNull();
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
