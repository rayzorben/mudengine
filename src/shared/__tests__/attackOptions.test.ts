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

  /*
   * 2026-10-05: a planner chose `aa` for Soul (level 14 Mystic) against a
   * tortured spirit (AC 50) on the bash's bigger blow before the roll. The server's
   * own `st a 408` puts punch 35, attack 22, kick 14, bash 10, jumpkick 3.
   */
  it('prices what lands on the monsters named, so armour turns the choice as the server does', () => {
    const soul: ProwessSheet = {
      ...SHEET,
      level: 14,
      agility: 90,
      charm: 70,
      combatLevel: 5,
      encumbrancePercent: 12,
      classCrits: 10
    };
    const basher = [
      [ATTACK_ABILITY.punch, 1],
      [ATTACK_ABILITY.kick, 1],
      [ATTACK_ABILITY.jumpkick, 1],
      [ATTACK_ABILITY.bash, 1]
    ] as const;
    const staff = { min: 2, max: 11, speed: 1300 };
    const spirit = { armourClass: 50, damageResist: 0, dodge: null, health: 150 };
    const order = (options: ReturnType<typeof attackOptions>): string[] =>
      [...options]
        .sort((a, b) => (b.perRound?.value ?? 0) - (a.perRound?.value ?? 0))
        .map((option) => option.verb);
    expect(order(attackOptions(soul, staff, basher, 'greatermud'))[0]).toBe('aa');
    expect(order(attackOptions(soul, staff, basher, 'greatermud', [spirit]))).toEqual([
      'pu',
      'a',
      'kic',
      'aa',
      'ju'
    ]);
  });

  it('prices nothing against a monster nobody can place', () => {
    const options = attackOptions(SHEET, null, MYSTIC, 'greatermud', [null]);
    for (const option of options) expect(option.perRound).toBeNull();
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
      const sheet = prowessSheetOf(wearing(equipped), { combat: 3, magery: null, crits: 0 });
      const option = attackOptions(sheet, null, MYSTIC, 'greatermud').find(
        (each) => each.verb === verb
      );
      return option?.perRound?.value ?? 0;
    };
    expect(round(true, 'pu')).toBeGreaterThan(round(false, 'pu'));
    expect(round(true, 'kic')).toBe(round(false, 'kic'));
  });
});
