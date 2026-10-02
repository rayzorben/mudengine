import { describe, expect, it } from 'vitest';

import {
  ganghouseHeld,
  keptRegardless,
  outgrownWay,
  type KitPiece,
  type WayChoice
} from '../outgrown';

const NONE = { supplies: [], sets: [], keys: [] };
const piece = (over: Partial<KitPiece> = {}): KitPiece => ({
  name: 'sandals',
  equipped: false,
  ...over
});

describe('what is kept whatever the ranking says', () => {
  it('keeps nothing ordinary', () => {
    expect(keptRegardless(piece(), NONE)).toBe(false);
  });

  it('keeps worn gear, keys, the supply list, gear sets, loyal items and ganghouse kit', () => {
    expect(keptRegardless(piece({ equipped: true }), NONE)).toBe(true);
    expect(keptRegardless(piece({ kind: 'key' }), NONE)).toBe(true);
    expect(keptRegardless(piece(), { ...NONE, keys: ['sandals'] })).toBe(true);
    expect(keptRegardless(piece(), { ...NONE, supplies: ['sandal'] })).toBe(true);
    expect(keptRegardless(piece(), { ...NONE, sets: ['sandals'] })).toBe(true);
    // A flag claims by presence: `LoyalItem 0` is loyal.
    expect(keptRegardless(piece({ abilities: [[100, 0]] }), NONE)).toBe(true);
    for (const id of [181, 183, 184]) {
      expect(keptRegardless(piece({ abilities: [[id, 3]] }), NONE)).toBe(true);
    }
  });
});

/* `gmud.mdb`, 2026-10-02: the ruby emblem is `GHouseItem 1` worn in 16; the ornate red key `GHouseItem 1`. */
const EMBLEM = piece({
  name: 'ruby emblem',
  equipped: true,
  wornSlotCode: 16,
  abilities: [[183, 1]]
});
const KEY = piece({ name: 'ornate red key', kind: 'key', abilities: [[183, 1]] });

describe('the ganghouse the character holds', () => {
  it('is the house the worn emblem names, with a key to it carried', () => {
    expect(ganghouseHeld([EMBLEM, KEY])).toEqual({ house: 1 });
    // The keyring, which the realm files as a scroll.
    const ring = piece({ name: 'red keyring', kind: 'scroll', abilities: [[183, 1]] });
    expect(ganghouseHeld([EMBLEM, ring])).toEqual({ house: 1 });
  });

  it('needs the emblem worn, not carried', () => {
    expect(ganghouseHeld([{ ...EMBLEM, equipped: false }, KEY])).toEqual({ missing: 'emblem' });
  });

  it('needs a key to that house, not another', () => {
    const other = { ...KEY, abilities: [[183, 2]] as Array<[number, number]> };
    expect(ganghouseHeld([EMBLEM, other])).toEqual({ missing: 'key' });
    const banner = piece({ name: 'red banner', kind: 'misc', abilities: [[183, 1]] });
    expect(ganghouseHeld([EMBLEM, banner])).toEqual({ missing: 'key' });
  });
});

const choice = (over: Partial<WayChoice> = {}): WayChoice => ({
  value: 5_000,
  stashFrom: 10_000,
  sellFrom: 1_000,
  stash: true,
  sell: true,
  drop: true,
  ...over
});

describe('which way an outgrown item goes', () => {
  it('stashes what is worth keeping, where the ganghouse is open', () => {
    expect(outgrownWay(choice({ value: 20_000 }))).toBe('stash');
    expect(outgrownWay(choice({ value: 20_000, stash: false }))).toBe('sell');
  });

  it('sells what is worth the walk, and drops the rest', () => {
    expect(outgrownWay(choice())).toBe('sell');
    expect(outgrownWay(choice({ sell: false }))).toBe('drop');
    expect(outgrownWay(choice({ value: 100 }))).toBe('drop');
  });

  it('sells what cannot be dropped, and keeps what can be neither', () => {
    expect(outgrownWay(choice({ value: 100, drop: false }))).toBe('sell');
    expect(outgrownWay(choice({ value: 100, drop: false, sell: false }))).toBeNull();
  });
});
