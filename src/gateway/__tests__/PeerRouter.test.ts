import { describe, expect, it } from 'vitest';

import type { PeerDown, ShareEntry } from '../../shared/peerWire';
import { PeerRouter, type InstallLine } from '../PeerRouter';

const REALM = 'orohost:2427/GreaterMUD';
const brakkle = { realm: REALM, name: 'Brakkle' };
const soul = { realm: REALM, name: 'Soul' };
const KEY_B = 'B'.repeat(43);
const KEY_S = 'S'.repeat(43);
const KEY_X = 'X'.repeat(43);

class Line implements InstallLine {
  readonly heard: PeerDown[] = [];
  send(frame: PeerDown): void {
    this.heard.push(frame);
  }
  kinds(): string[] {
    return this.heard.map((frame) => frame.k);
  }
  take(): PeerDown[] {
    return this.heard.splice(0);
  }
}

const toSoul: ShareEntry[] = [{ name: 'Soul', share: 'state', key: null }];

function setUp(): { router: PeerRouter; sharer: Line; receiver: Line } {
  const router = new PeerRouter(10_000);
  const sharer = new Line();
  const receiver = new Line();
  router.claim(sharer, brakkle, KEY_B);
  return { router, sharer, receiver };
}

describe('the router', () => {
  it('sends a receiver the whole sheet when it connects, then each patch', () => {
    const { router, sharer, receiver } = setUp();
    const other = new Line();
    router.claim(other, { realm: REALM, name: 'Rayzor' }, KEY_X);
    expect(
      router.setShares(sharer, brakkle, [...toSoul, { name: 'Rayzor', share: 'state', key: null }])
    ).toBeNull();
    expect(router.sheet(sharer, brakkle, { v: 1, level: 12 })).toBeNull();

    router.claim(receiver, soul, KEY_S);
    expect(receiver.take()).toEqual([
      { k: 'shared', from: brakkle, key: KEY_B, to: ['Soul'] },
      { k: 'sheet', from: brakkle, sheet: { v: 1, level: 12 } }
    ]);
    expect(router.patch(sharer, brakkle, { set: { level: 13 }, deep: {}, drop: [] })).toBeNull();
    expect(receiver.take()).toEqual([
      { k: 'patch', from: brakkle, set: { level: 13 }, deep: {}, drop: [] }
    ]);
    // A receiver that connects now is sent the sheet as patched, not as first sent.
    const late = new Line();
    router.leave(other, { realm: REALM, name: 'Rayzor' });
    router.claim(late, { realm: REALM, name: 'Rayzor' }, KEY_X);
    expect(late.heard).toContainEqual({ k: 'sheet', from: brakkle, sheet: { v: 1, level: 13 } });
  });

  it('sends nothing to a name the sharer does not list, until it lists it', () => {
    const { router, sharer, receiver } = setUp();
    router.claim(receiver, soul, KEY_S);
    router.setShares(sharer, brakkle, [{ name: 'Rayzor', share: 'state', key: null }]);
    router.sheet(sharer, brakkle, { v: 1 });
    expect(receiver.heard).toEqual([]);
    router.setShares(sharer, brakkle, toSoul);
    router.sheet(sharer, brakkle, { v: 1 });
    expect(receiver.kinds()).toEqual(['shared', 'sheet']);
  });

  it('tells a sharer nobody listens until a listed receiver connects', () => {
    const { router, sharer, receiver } = setUp();
    router.setShares(sharer, brakkle, toSoul);
    expect(sharer.take()).toEqual([{ k: 'audience', peer: brakkle, to: [] }]);
    // A sheet sent with nobody listening is not kept, so nobody is later sent it stale.
    router.sheet(sharer, brakkle, { v: 1, stale: true });
    router.claim(receiver, soul, KEY_S);
    expect(sharer.take()).toEqual([
      { k: 'audience', peer: brakkle, to: [{ name: 'Soul', key: KEY_S }] }
    ]);
    expect(receiver.kinds()).toEqual(['shared']);
    // And when it goes, the sharer is told to stop.
    router.dropLine(receiver);
    expect(sharer.take()).toEqual([{ k: 'audience', peer: brakkle, to: [] }]);
  });

  it('refuses a frame naming a character this socket has not claimed, another realm included', () => {
    const { router, sharer } = setUp();
    const elsewhere = { realm: 'paramud.mudinfo.net:2323/Paradigm', name: 'Brakkle' };
    expect(router.setShares(sharer, elsewhere, toSoul)).toBe('not-claimed');
    expect(router.sheet(sharer, elsewhere, { v: 1 })).toBe('not-claimed');
    // The same frames for the realm it claimed are taken.
    expect(router.setShares(sharer, brakkle, toSoul)).toBeNull();
    expect(router.sheet(sharer, brakkle, { v: 1 })).toBeNull();
  });

  it('never routes a share to the same name in another realm', () => {
    const { router, sharer } = setUp();
    const away = new Line();
    router.claim(away, { realm: 'paramud.mudinfo.net:2323/Paradigm', name: 'Soul' }, KEY_S);
    router.setShares(sharer, brakkle, toSoul);
    expect(away.heard).toEqual([]);
  });

  it('sends nothing to a listed name held by another key, and tells the sharer once', () => {
    const { router, sharer, receiver } = setUp();
    router.claim(receiver, soul, KEY_X);
    router.setShares(sharer, brakkle, [{ name: 'Soul', share: 'state', key: KEY_S }]);
    expect(receiver.heard).toEqual([]);
    expect(sharer.take()).toEqual([
      { k: 'audience', peer: brakkle, to: [] },
      { k: 'unshared', peer: brakkle, name: 'Soul', why: 'another-key' }
    ]);
    router.setShares(sharer, brakkle, [{ name: 'Soul', share: 'state', key: KEY_S }]);
    expect(sharer.heard).toEqual([]);
    // The key the share was granted to is sent the sheet: the control.
    const owner = new Line();
    router.claim(owner, soul, KEY_S);
    expect(owner.kinds()).toEqual(['shared']);
  });

  it('tells every receiver when the sharer leaves', () => {
    const { router, sharer, receiver } = setUp();
    router.claim(receiver, soul, KEY_S);
    router.setShares(sharer, brakkle, toSoul);
    receiver.take();
    router.dropLine(sharer);
    expect(receiver.take()).toEqual([{ k: 'gone', from: brakkle, why: 'left' }]);
  });

  it('tells a receiver the sharer stopped sharing with it', () => {
    const { router, sharer, receiver } = setUp();
    router.claim(receiver, soul, KEY_S);
    router.setShares(sharer, brakkle, toSoul);
    receiver.take();
    router.setShares(sharer, brakkle, []);
    expect(receiver.take()).toEqual([{ k: 'gone', from: brakkle, why: 'unshared' }]);
  });

  it('refuses a patch before any sheet, and one that does not fit the sheet', () => {
    const { router, sharer, receiver } = setUp();
    router.claim(receiver, soul, KEY_S);
    router.setShares(sharer, brakkle, toSoul);
    const deep = { vitals: { k: 'fields' as const, set: { hp: 3 }, deep: {}, drop: [] } };
    expect(router.patch(sharer, brakkle, { set: {}, deep, drop: [] })).toBe('no-sheet');
    router.sheet(sharer, brakkle, { v: 1, vitals: 7 });
    expect(router.patch(sharer, brakkle, { set: {}, deep, drop: [] })).toBe('malformed');
    router.sheet(sharer, brakkle, { v: 1, vitals: { hp: 1 } });
    expect(router.patch(sharer, brakkle, { set: {}, deep, drop: [] })).toBeNull();
  });

  it('refuses a patch that grows the sheet past the frame limit', () => {
    const { router, sharer, receiver } = setUp();
    router.claim(receiver, soul, KEY_S);
    router.setShares(sharer, brakkle, toSoul);
    router.sheet(sharer, brakkle, { v: 1 });
    expect(
      router.patch(sharer, brakkle, { set: { a: 'x'.repeat(5_000) }, deep: {}, drop: [] })
    ).toBeNull();
    expect(
      router.patch(sharer, brakkle, { set: { b: 'x'.repeat(5_000) }, deep: {}, drop: [] })
    ).toBe('malformed');
  });

  it('counts what each socket holds, and lets a later claim of the same name take it', () => {
    const { router, sharer } = setUp();
    expect(router.heldBy(sharer)).toBe(1);
    const again = new Line();
    router.claim(again, brakkle, KEY_B);
    expect(router.heldBy(sharer)).toBe(0);
    expect(router.heldBy(again)).toBe(1);
    expect(router.leave(sharer, brakkle)).toBe('not-claimed');
  });
});
