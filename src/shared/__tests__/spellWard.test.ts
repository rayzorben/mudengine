import { describe, expect, it } from 'vitest';

import type { ItemEntity } from '../entities';
import type { MenacePlayer } from '../menace';
import { spellEffect } from '../mobRound';
import { hazardWarded, NO_WARD, wardedFrom, wardOf } from '../spellWard';
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
    expect(wardedFrom(venom, wardOf([], 100))).toBe(true);
    expect(wardedFrom(venom, wardOf([], 0))).toBe(true);
    expect(wardedFrom(venom, wardOf([], null))).toBe(false);
    expect(wardedFrom(venom, wardOf([{ equipped: true, abilities: [[21, 100]] }], null))).toBe(
      true
    );
    expect(wardedFrom(drain, NO_WARD)).toBe(false);
  });

  /*
   * gmud.zip's swamp poison (485): poison-typed, Damage on its own roll.
   * `Spell.CheckResistance` returns 0 at an ImmuPoison sum of 100 and the
   * whole figure under it; a Kang's race row is 100, a demonhide piece 20.
   */
  describe('a poison-typed spell’s damage', () => {
    const swamp: WorldSpell = {
      id: 485,
      name: 'swamp poison',
      abilities: [
        [1, 0],
        [144, 0]
      ],
      power: [2, 20],
      element: 'poison',
      hazard: { damage: 11, summons: true, reach: { damage: [{}], summons: [{}] } }
    };
    const demonhide = { equipped: true, abilities: [[21, 20]] as [number, number][] };

    it('is 0 at an ImmuPoison sum of 100, from the race or from gear, and whole under it', () => {
      expect(wardOf([], 100).poisonProof).toBe(true);
      expect(wardOf(Array(5).fill(demonhide), null).poisonProof).toBe(true);
      expect(wardOf(Array(4).fill(demonhide), null).poisonProof).toBe(false);
      expect(wardOf([demonhide], 80).poisonProof).toBe(true);
      expect(wardOf([{ ...demonhide, equipped: false }], 80).poisonProof).toBe(false);
      expect(wardOf([], null).poisonProof).toBe(false);
      expect(hazardWarded(swamp, wardOf([], 100))).toEqual({
        summons: true,
        reach: { summons: [{}] }
      });
      expect(hazardWarded(swamp, wardOf([], 99))).toBe(swamp.hazard);
      expect(hazardWarded(swamp, undefined)).toBe(swamp.hazard);
    });

    it('is 0 for a DamageWithMR row and a later spell’s chain too', () => {
      const proof = wardOf([], 100);
      const resisted = { ...swamp, abilities: [[17, 0] as [number, number]] };
      expect(hazardWarded(resisted, proof)?.damage).toBeUndefined();
      const chained = { ...swamp, abilities: [...swamp.abilities!, [151, 9] as [number, number]] };
      expect(hazardWarded(chained, proof)?.damage).toBeUndefined();
    });

    it('is kept for another element, a drain or Poison row beside it, and a script', () => {
      const proof = wardOf([], 100);
      const heat = { ...swamp, element: 'fire' as const };
      expect(hazardWarded(heat, proof)).toBe(swamp.hazard);
      for (const row of [8, 19, 148]) {
        const mixed = { ...swamp, abilities: [...swamp.abilities!, [row, 9] as [number, number]] };
        expect(hazardWarded(mixed, proof)).toBe(swamp.hazard);
      }
    });
  });

  it('does nothing to the character in the fight, and its summons still come', () => {
    const ward = wardOf([cross], 100);
    expect(spellEffect(drain, 0, BARE)).not.toBeNull();
    expect(spellEffect(drain, 0, { ...BARE, ward })).toBeNull();
    expect(spellEffect(venom, 0, { ...BARE, ward })).toBeNull();
    const called = spellEffect(calling, 0, { ...BARE, ward })!;
    expect(called.high).toBe(0);
    expect(called.summons.length).toBeGreaterThan(0);
  });
});
