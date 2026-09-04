import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SplitMemory } from '../SplitMemory';
import { WorldMemory } from '../WorldMemory';
import type { Discovery } from '../../../shared/memory';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-split-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const exit = (over: Partial<Discovery> = {}): Discovery => ({
  reason: 'unknown-exit',
  from: '1/10',
  fromName: 'Cliff Top',
  command: 'jump cliff',
  to: '1/12',
  name: 'Narrow Ledge',
  exits: ['u'],
  at: 1_700_000_000_000,
  ...over
});

const stock = (over: Partial<Discovery> = {}): Discovery => ({
  reason: 'unknown-stock',
  from: '1/3302',
  fromName: "Jorah's Plate/Scale",
  command: 'black plate leggings',
  to: null,
  name: 'black plate leggings',
  exits: [],
  at: 1_700_000_000_000,
  ...over
});

const own = (who: string) => new WorldMemory(path.join(dir, `${who}.json`), 'test-realm');
const shared = () => new WorldMemory(path.join(dir, 'realm-test.json'), 'test-realm');

describe('a character’s memory, with the realm’s half shared', () => {
  /*
   * The reported complaint. A shop's stock is a fact about the world — the
   * reasoning `RealmLore` and `PlayerBook` already follow — so the second
   * character to walk in must not spend the `list` that teaches it again, nor
   * announce it as a discovery.
   */
  it('lets a second character read what the first learned about a shop', () => {
    const realm = shared();
    new SplitMemory(own('vaelor'), realm).learn(stock());

    const soul = new SplitMemory(own('soul'), realm);
    expect(soul.learn(stock())).toBeNull();
    expect(soul.all.map((entry) => entry.command)).toEqual(['black plate leggings']);
  });

  /*
   * And the other half stays private, which is the reason `WorldMemory` is per
   * character in the first place: a corridor one character has walked is that
   * character's own exploration, and a second has not been there.
   */
  it('keeps an exit to the character that walked it', () => {
    const realm = shared();
    new SplitMemory(own('vaelor'), realm).learn(exit());

    const soul = new SplitMemory(own('soul'), realm);
    expect(soul.learn(exit())).not.toBeNull();
    expect(soul.all.map((entry) => entry.reason)).toEqual(['unknown-exit']);
  });

  /* Every reader asks "what has been learned here", and both halves answer. */
  it('reads as one record', () => {
    const memory = new SplitMemory(own('vaelor'), shared());
    memory.learn(exit());
    memory.learn(stock());
    expect(memory.all.map((entry) => entry.reason)).toEqual(['unknown-exit', 'unknown-stock']);
  });

  /*
   * A row struck out from a card has to go from the file it is actually in, and
   * the caller has only a key — it does not know which store holds it.
   */
  it('strikes a row out of whichever half holds it', () => {
    const memory = new SplitMemory(own('vaelor'), shared());
    memory.learn(exit());
    memory.learn(stock());

    expect(memory.forget('1/3302|black plate leggings')).toBe(true);
    expect(memory.forget('1/10|jump cliff')).toBe(true);
    expect(memory.forget('1/999|nowhere')).toBe(false);
    expect(memory.all).toEqual([]);
  });

  /* Each half writes its own file, which is what makes the sharing survive a restart. */
  it('persists the two halves separately', () => {
    const vaelor = own('vaelor');
    const realm = shared();
    const memory = new SplitMemory(vaelor, realm);
    memory.learn(exit());
    memory.learn(stock());
    vaelor.close();
    realm.close();

    const back = new SplitMemory(own('vaelor'), shared());
    expect(back.all.map((entry) => entry.reason)).toEqual(['unknown-exit', 'unknown-stock']);
    // And the realm's half alone holds the shop, so a fresh character gets it.
    expect(new SplitMemory(own('yang'), shared()).all.map((entry) => entry.reason)).toEqual([
      'unknown-stock'
    ]);
  });
});
