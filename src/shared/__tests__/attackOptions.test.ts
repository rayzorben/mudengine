import { describe, expect, it } from 'vitest';

import { ATTACK_ABILITY, MARTIAL_ACCURACY_ABILITY, MARTIAL_DAMAGE_ABILITY } from '../abilities';
import { attackFor, attackOptions } from '../attackOptions';
import { gearEffect } from '../blessingeffects';
import { EMPTY_CHARACTER, type CharacterState } from '../character';
import { PLAIN_ATTACK, type ProwessSheet } from '../prowess';
import { prowessSheetOf } from '../verdict';

const MYSTIC: ReadonlyArray<readonly [number, number]> = [
  [ATTACK_ABILITY.punch, 1],
  [ATTACK_ABILITY.kick, 1],
  [ATTACK_ABILITY.jumpkick, 1],
  [MARTIAL_DAMAGE_ABILITY.kick, 3]
];

const SHEET: ProwessSheet = {
  level: 10,
  agility: 80,
  intellect: 50,
  charm: 50,
  willpower: 30,
  health: 53,
  strength: 82,
  spellcasting: null,
  combatLevel: 3,
  mageryLevel: null,
  encumbrancePercent: 10
};

describe('the attack combat.attack types', () => {
  it('is read by the realm’s command table, with its damage bonus', () => {
    expect(attackFor('ki', MYSTIC)).toEqual({ kind: 'kick', bonus: 3 });
    expect(attackFor('kic', MYSTIC)).toEqual({ kind: 'kick', bonus: 3 });
    expect(attackFor('allout', [[ATTACK_ABILITY.bash, 1]])).toEqual({ kind: 'bash', bonus: 0 });
    expect(attackFor('kick', MYSTIC)).toEqual({ kind: 'kick', bonus: 3 });
    expect(attackFor('pu', MYSTIC)).toEqual({ kind: 'punch', bonus: 0 });
    expect(attackFor('a', MYSTIC)).toEqual(PLAIN_ATTACK);
  });

  it('is the plain attack where the class cannot make it or the verb is unknown', () => {
    expect(attackFor('kic', [])).toEqual(PLAIN_ATTACK);
    expect(attackFor('kic', null)).toEqual(PLAIN_ATTACK);
    expect(attackFor('dance', MYSTIC)).toEqual(PLAIN_ATTACK);
    expect(attackFor('', MYSTIC)).toEqual(PLAIN_ATTACK);
  });
});

describe('the attacks offered', () => {
  it('prices a bare hand and every martial attack the class holds', () => {
    const options = attackOptions(SHEET, null, MYSTIC, 'greatermud');
    expect(options.map((option) => option.verb)).toEqual(['a', 'pu', 'kic', 'ju']);
    for (const option of options) expect(option.perRound?.value).toBeGreaterThan(0);
  });
});

/*
 * `Player.GetAbility` sums the worn items' rows beside the class's: clawed
 * gloves add 3 to a punch's blow and 3 to its roll (2026-10-03, a Mystic whose
 * punches were priced bare-handed).
 */
describe('a martial attack with gear on', () => {
  const GLOVES: Array<[number, number]> = [
    [MARTIAL_ACCURACY_ABILITY.punch, 3],
    [MARTIAL_DAMAGE_ABILITY.punch, 3]
  ];
  const wearing = (equipped: boolean): CharacterState => {
    const base = structuredClone(EMPTY_CHARACTER);
    return {
      ...base,
      progress: { ...base.progress, ...SHEET },
      inventory: {
        ...base.inventory,
        items: [{ name: 'clawed gloves', equipped, abilities: GLOVES } as never]
      }
    };
  };

  it('sums the martial rows of what is worn, and nothing carried', () => {
    expect(gearEffect(wearing(true).inventory.items)?.martialDamage).toEqual({
      punch: 3,
      kick: 0,
      jumpkick: 0
    });
    expect(gearEffect(wearing(true).inventory.items)?.martialAccuracy.punch).toBe(3);
    expect(gearEffect(wearing(false).inventory.items)).toBeNull();
  });

  it('punches harder in the gloves, and kicks no harder', () => {
    const round = (equipped: boolean, verb: string): number => {
      const sheet = prowessSheetOf(wearing(equipped), { combat: 3, magery: null });
      const option = attackOptions(sheet, null, MYSTIC, 'greatermud').find(
        (each) => each.verb === verb
      );
      return option?.perRound?.value ?? 0;
    };
    expect(round(true, 'pu')).toBeGreaterThan(round(false, 'pu'));
    expect(round(true, 'kic')).toBe(round(false, 'kic'));
  });
});
