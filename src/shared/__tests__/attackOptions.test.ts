import { describe, expect, it } from 'vitest';

import { ATTACK_ABILITY, MARTIAL_DAMAGE_ABILITY } from '../abilities';
import { attackFor, attackOptions } from '../attackOptions';
import { PLAIN_ATTACK, type ProwessSheet } from '../prowess';

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
