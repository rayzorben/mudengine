import { describe, expect, it } from 'vitest';

import { healthLeft } from '../character';
import { meleeFinishes } from '../meleeFinishes';
import { swing, swingRound, type ProwessSheet } from '../prowess';

const SHEET: ProwessSheet = {
  level: 10,
  agility: 60,
  intellect: 50,
  charm: 55,
  willpower: 50,
  health: 60,
  strength: 55,
  spellcasting: 40,
  combatLevel: 4,
  mageryLevel: null,
  encumbrancePercent: 20,
  stated: { attacks: { attack: { accuracy: 105, swings: 3, damage: { min: 8, max: 25 } } } }
};
const SWORD = { min: 5, max: 12, speed: 20, strength: 30, accuracy: 5 };
const ORC = { armour: 40, damageResist: 0, hp: 60 };
const round = swingRound(
  swing(SHEET, SWORD, { armourClass: 40, damageResist: 0, dodge: null, health: 60 }, 'greatermud')!
)!;

describe('whether the melee round is expected to finish the monster', () => {
  it('holds at or under the round, with the figures', () => {
    const left = Math.floor(round);
    expect(meleeFinishes(left, SHEET, SWORD, ORC, 'greatermud')).toEqual({ left, round });
  });

  it('does not over it (the control)', () => {
    expect(meleeFinishes(Math.ceil(round) + 1, SHEET, SWORD, ORC, 'greatermud')).toBeNull();
  });

  it('answers nothing for unknown health or an unpriced swing', () => {
    expect(meleeFinishes(null, SHEET, SWORD, ORC, 'greatermud')).toBeNull();
    expect(meleeFinishes(0, SHEET, SWORD, ORC, 'greatermud')).toBeNull();
    expect(meleeFinishes(1, SHEET, SWORD, ORC, 'majormud')).toBeNull();
  });
});

describe('hit points believed left', () => {
  it('is the share of the maximum, and unknown while either is', () => {
    expect(healthLeft({ max: 60, remaining: 0.25 })).toBe(15);
    expect(healthLeft({ max: null, remaining: 0.25 })).toBeNull();
    expect(healthLeft({ max: 60, remaining: null })).toBeNull();
    expect(healthLeft(null)).toBeNull();
  });
});
