import { describe, expect, it } from 'vitest';

import type { PeerDown, ShareEntry } from '../../shared/peerWire';
import { PeerRouter, type InstallLine } from '../PeerRouter';

const REALM = 'orohost:2427/GreaterMUD';
const brakkle = { realm: REALM, name: 'Brakkle' };
const soul = { realm: REALM, name: 'Soul' };
const rayzor = { realm: REALM, name: 'Rayzor' };
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

const share = (name: string, keys: string[] = []): ShareEntry => ({ name, share: 'state', keys });
const toSoul = [share('Soul')];

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
    router.claim(other, rayzor, KEY_X);
    expect(router.setShares(sharer, brakkle, [...toSoul, share('Rayzor')])).toBeNull();
    expect(router.sheet(sharer, brakkle, { v: 1, level: 12 })).toBeNull();

    router.claim(receiver, soul, KEY_S);
    expect(receiver.take()).toEqual([
      { k: 'shared', from: brakkle, key: KEY_B, to: ['Soul'] },
      { k: 'sheet', from: brakkle, key: KEY_B, sheet: { v: 1, level: 12 } }
    ]);
    expect(router.patch(sharer, brakkle, { set: { level: 13 }, deep: {}, drop: [] })).toBeNull();
    expect(receiver.take()).toEqual([
      { k: 'patch', from: brakkle, key: KEY_B, set: { level: 13 }, deep: {}, drop: [] }
    ]);
    // A receiver that connects now is sent the sheet as patched, not as first sent.
    const late = new Line();
    router.leave(other, rayzor);
    router.claim(late, rayzor, KEY_X);
    expect(late.heard).toContainEqual({
      k: 'sheet',
      from: brakkle,
      key: KEY_B,
      sheet: { v: 1, level: 13 }
    });
  });

  it('sends nothing to a name the sharer does not list, until it lists it', () => {
    const { router, sharer, receiver } = setUp();
    router.claim(receiver, soul, KEY_S);
    router.setShares(sharer, brakkle, [share('Rayzor')]);
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

  it('lets two installs claim one name under two keys, and an unpinned share reaches both', () => {
    const { router, sharer, receiver } = setUp();
    const second = new Line();
    router.claim(receiver, soul, KEY_S);
    router.claim(second, soul, KEY_X);
    router.setShares(sharer, brakkle, toSoul);
    expect(receiver.kinds()).toEqual(['shared']);
    expect(second.kinds()).toEqual(['shared']);
    expect(sharer.heard).toContainEqual({
      k: 'audience',
      peer: brakkle,
      to: [
        { name: 'Soul', key: KEY_S },
        { name: 'Soul', key: KEY_X }
      ]
    });
  });

  it('sends a share pinned to one key nothing under another, and tells the sharer once', () => {
    const { router, sharer, receiver } = setUp();
    router.claim(receiver, soul, KEY_X);
    router.setShares(sharer, brakkle, [share('Soul', [KEY_S])]);
    expect(receiver.heard).toEqual([]);
    expect(sharer.take()).toEqual([
      { k: 'audience', peer: brakkle, to: [] },
      { k: 'unshared', peer: brakkle, name: 'Soul', key: KEY_X, why: 'another-key' }
    ]);
    router.setShares(sharer, brakkle, [share('Soul', [KEY_S])]);
    expect(sharer.heard).toEqual([]);
    // The key the share was pinned to is sent the sheet, beside the other: the control.
    const owner = new Line();
    router.claim(owner, soul, KEY_S);
    expect(owner.kinds()).toEqual(['shared']);
    expect(receiver.heard).toEqual([]);
  });

  it('tells every receiver when the sharer leaves', () => {
    const { router, sharer, receiver } = setUp();
    router.claim(receiver, soul, KEY_S);
    router.setShares(sharer, brakkle, toSoul);
    receiver.take();
    router.dropLine(sharer);
    expect(receiver.take()).toEqual([{ k: 'gone', from: brakkle, key: KEY_B, why: 'left' }]);
  });

  it('tells a receiver the sharer stopped sharing with it', () => {
    const { router, sharer, receiver } = setUp();
    router.claim(receiver, soul, KEY_S);
    router.setShares(sharer, brakkle, toSoul);
    receiver.take();
    router.setShares(sharer, brakkle, []);
    expect(receiver.take()).toEqual([{ k: 'gone', from: brakkle, key: KEY_B, why: 'unshared' }]);
  });

  it('keeps two claims of one sharer under two keys apart', () => {
    const { router, sharer, receiver } = setUp();
    const laptop = new Line();
    router.claim(laptop, brakkle, KEY_X);
    router.claim(receiver, soul, KEY_S);
    router.setShares(sharer, brakkle, toSoul);
    router.setShares(laptop, brakkle, toSoul);
    router.sheet(sharer, brakkle, { v: 1, from: 'desktop' });
    router.sheet(laptop, brakkle, { v: 1, from: 'laptop' });
    const sheets = receiver.heard.filter((frame) => frame.k === 'sheet');
    expect(sheets).toEqual([
      { k: 'sheet', from: brakkle, key: KEY_B, sheet: { v: 1, from: 'desktop' } },
      { k: 'sheet', from: brakkle, key: KEY_X, sheet: { v: 1, from: 'laptop' } }
    ]);
    // One leaving leaves the other streaming.
    router.dropLine(laptop);
    expect(receiver.heard.at(-1)).toEqual({ k: 'gone', from: brakkle, key: KEY_X, why: 'left' });
    expect(router.patch(sharer, brakkle, { set: { level: 2 }, deep: {}, drop: [] })).toBeNull();
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
    const grow = (field: string): ReturnType<PeerRouter['patch']> =>
      router.patch(sharer, brakkle, { set: { [field]: 'x'.repeat(5_000) }, deep: {}, drop: [] });
    expect(grow('a')).toBeNull();
    expect(grow('b')).toBe('malformed');
  });

  it('counts what each socket holds, and lets a later claim of the same name and key take it', () => {
    const { router, sharer } = setUp();
    expect(router.heldBy(sharer)).toBe(1);
    const again = new Line();
    router.claim(again, brakkle, KEY_B);
    expect(router.heldBy(sharer)).toBe(0);
    expect(router.heldBy(again)).toBe(1);
    expect(router.leave(sharer, brakkle)).toBe('not-claimed');
  });
});
