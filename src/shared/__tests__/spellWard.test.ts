import { describe, expect, it } from 'vitest';

import type { ItemEntity } from '../entities';
import type { MenacePlayer } from '../menace';
import { spellEffect } from '../mobRound';
import { NO_WARD, wardedFrom, wardOf } from '../spellWard';
import type { WorldSpell } from '../world';

/*
 * Todo 2322-01, from pmud-20260931.mdb: the large silvery cross negates
 * drain life (101) among nine others, and a Kang's race row carries
 * ImmuPoison (21) at 100.
 */
const cross: Pick<ItemEntity, 'equipped' | 'negates' | 'abilities'> = {
  equipped: true,
  negates: [101, 361, 432]
};
const drain: WorldSpell = { id: 101, name: 'drain life', abilities: [[8, 0]], power: [20, 30] };
const venom: WorldSpell = {
  id: 7,
  name: 'poison bite',
  abilities: [
    [1, 0],
    [19, 0]
  ],
  power: [10, 20]
};
const calling: WorldSpell = {
  id: 9,
  name: 'call for help',
  abilities: [
    [19, 0],
    [12, 880]
  ],
  power: [5, 5],
  summons: [[[880, 1]]]
};
const BARE: MenacePlayer = { armourClass: 0, damageResist: 0, magicRes: 0 };

describe('a spell that never reaches the character', () => {
  it('is one a worn item negates, and not one carried', () => {
    expect(wardedFrom(drain, wardOf([cross], null))).toBe(true);
    expect(wardedFrom(drain, wardOf([{ ...cross, equipped: false }], null))).toBe(false);
    expect(wardedFrom(venom, wardOf([cross], null))).toBe(false);
  });

  it('is any spell carrying Poison against ImmuPoison, from the race or from gear', () => {
    expect(wardedFrom(venom, wardOf([], true))).toBe(true);
    expect(wardedFrom(venom, wardOf([], null))).toBe(false);
    expect(wardedFrom(venom, wardOf([{ equipped: true, abilities: [[21, 100]] }], false))).toBe(
      true
    );
    expect(wardedFrom(drain, NO_WARD)).toBe(false);
  });

  it('does nothing to the character in the fight, and its summons still come', () => {
    const ward = wardOf([cross], true);
    expect(spellEffect(drain, 0, BARE)).not.toBeNull();
    expect(spellEffect(drain, 0, { ...BARE, ward })).toBeNull();
    expect(spellEffect(venom, 0, { ...BARE, ward })).toBeNull();
    const called = spellEffect(calling, 0, { ...BARE, ward })!;
    expect(called.high).toBe(0);
    expect(called.summons.length).toBeGreaterThan(0);
  });
});
