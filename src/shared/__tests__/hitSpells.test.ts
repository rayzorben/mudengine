import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../dice';
import {
  hitSpellCasts,
  hitSpellMean,
  hitSpellsOf,
  rollHitSpells,
  type HitSpell,
  type HitSpellTarget
} from '../hitSpells';
import { swing, swingRound, type ProwessSheet } from '../prowess';
import type { MonsterNature } from '../spellReach';
import type { WorldSpell } from '../world';

/* gmud.zip spell 400 `frost hits`: DamageNoMR, 2–8, cold, no growth. */
const FROST: WorldSpell = {
  id: 400,
  name: 'frost hits',
  power: [2, 8],
  element: 'cold',
  abilities: [[1, 0]]
};
/* A hit spell that does something other than damage (gmud.zip 318 `knockdown`). */
const KNOCKDOWN: WorldSpell = { id: 318, name: 'knockdown', power: [-5, -5], abilities: [[71, 0]] };

const SPELLS = new Map([FROST, KNOCKDOWN].map((spell) => [spell.id, spell]));
const byId = (id: number): WorldSpell | null => SPELLS.get(id) ?? null;

const LIVING: MonsterNature = {
  nonLiving: false,
  animal: false,
  undead: false,
  spellImmunity: [0, 0]
};
const FROSTBITE: HitSpell[] = [{ chance: 100, spell: FROST }];

/** What the hit spells add to one damaging blow, the way `swing` reads them. */
const hitSpellPerBlow = (hits: HitSpell[], target: HitSpellTarget, spellcasting: number): number =>
  hitSpellMean(hitSpellCasts(hits, target, spellcasting));

describe('the hit spells an item names', () => {
  it('pairs a %Spell row with the CastsSp row right after it (blizzardfang)', () => {
    expect(
      hitSpellsOf(
        {
          abilities: [
            [114, 100],
            [43, 400]
          ]
        },
        byId
      )
    ).toEqual([{ chance: 100, spell: FROST }]);
  });

  it('reads a CastsSp with no %Spell before it as a spell the item casts when used', () => {
    const used: Array<[number, number]> = [
      [43, 400],
      [114, 25]
    ];
    expect(hitSpellsOf({ abilities: used }, byId)).toEqual([]);
    // Positive control: the same rows in the server's order are a hit spell.
    expect(hitSpellsOf({ abilities: [used[1]!, used[0]!] }, byId)).toHaveLength(1);
  });

  it('casts every CastsSp behind one %Spell, across an empty slot, as the server does', () => {
    // blood lance: [114, 25], [43, 402], [43, 894]; serrated bone war-spear: an empty slot between.
    const twice = hitSpellsOf(
      {
        abilities: [
          [114, 25],
          [43, 400],
          [0, 201],
          [43, 318]
        ]
      },
      byId
    );
    expect(twice).toEqual([
      { chance: 25, spell: FROST },
      { chance: 25, spell: KNOCKDOWN }
    ]);
  });

  it('leaves out a spell the realm has no row for', () => {
    expect(
      hitSpellsOf(
        {
          abilities: [
            [114, 100],
            [43, 999]
          ]
        },
        byId
      )
    ).toEqual([]);
  });
});

describe('what a hit spell adds to a damaging blow', () => {
  it('is the base power at the chance, as the wire measured it', () => {
    // festus.log: 13,915 casts of 2–8 for a mean of 5.018 on a level-32 Paladin.
    expect(hitSpellPerBlow(FROSTBITE, { nature: LIVING, abilities: [] }, 40)).toBeCloseTo(5, 6);
    expect(hitSpellPerBlow([{ chance: 25, spell: FROST }], { nature: LIVING }, 40)).toBeCloseTo(
      1.25,
      6
    );
  });

  it('hits for a figure the damage row states, past the roll and every resistance', () => {
    const stated: HitSpell[] = [{ chance: 100, spell: { ...FROST, abilities: [[1, 12]] } }];
    expect(hitSpellPerBlow(stated, { nature: LIVING, abilities: [[3, 50]] }, 300)).toBe(12);
    // Positive control: the rolled row in the same place is halved by the cold resistance.
    expect(hitSpellPerBlow(FROSTBITE, { nature: LIVING, abilities: [[3, 50]] }, 40)).toBeLessThan(
      5
    );
  });

  it('takes the element off what the target resists', () => {
    const cold = hitSpellPerBlow(FROSTBITE, { nature: LIVING, abilities: [[3, 50]] }, 40);
    // trunc(v / 2) over 2..8: 1,1,2,2,3,3,4.
    expect(cold).toBeCloseTo(16 / 7, 6);
  });

  it('adds the spellcasting bonus a player casts with', () => {
    // 300 spellcasting is 4%; trunc(v × 1.04) leaves 2..8 unchanged.
    expect(hitSpellPerBlow(FROSTBITE, { nature: LIVING }, 300)).toBeCloseTo(5, 6);
    const big: HitSpell[] = [{ chance: 100, spell: { ...FROST, power: [100, 100] } }];
    expect(hitSpellPerBlow(big, { nature: LIVING }, 300)).toBe(104);
  });

  it('counts nothing for a spell that does no damage, or a target it may not reach', () => {
    expect(hitSpellPerBlow([{ chance: 100, spell: KNOCKDOWN }], { nature: LIVING }, 40)).toBe(0);
    expect(hitSpellPerBlow(FROSTBITE, {}, 40)).toBe(0);
    expect(
      hitSpellPerBlow(FROSTBITE, { nature: { ...LIVING, spellImmunity: [999, 999] } }, 40)
    ).toBe(0);
    // A lower immunity does not stop a hit spell (`inOverrideSpellImmuCheck`).
    expect(
      hitSpellPerBlow(FROSTBITE, { nature: { ...LIVING, spellImmunity: [50, 50] } }, 40)
    ).toBeCloseTo(5, 6);
  });
});

describe('a hit spell rolled on a blow', () => {
  it('averages what the mean says, at the chance it is cast', () => {
    const casts = hitSpellCasts([{ chance: 86, spell: FROST }], { nature: LIVING }, 40);
    const random = mulberry32(125);
    let total = 0;
    for (let n = 0; n < 20000; n++) total += rollHitSpells(random, casts);
    expect(hitSpellMean(casts)).toBeCloseTo(5 * 0.86, 6);
    expect(Math.abs(total / 20000 - hitSpellMean(casts))).toBeLessThan(0.2);
  });

  it('rolls nothing for a spell that does no damage', () => {
    const casts = hitSpellCasts([{ chance: 100, spell: KNOCKDOWN }], { nature: LIVING }, 40);
    expect(casts).toEqual([]);
    expect(rollHitSpells(mulberry32(1), casts)).toBe(0);
  });
});

describe('a swing with a weapon that casts', () => {
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
    encumbrancePercent: 20
  };
  const SWORD = { min: 5, max: 12, speed: 20, strength: 30, accuracy: 5 };
  const target = {
    armourClass: 30,
    damageResist: 2,
    dodge: 10,
    health: 120,
    magicRes: 50,
    abilities: [],
    nature: LIVING
  };

  it('adds the spell to each damaging blow and takes fewer rounds', () => {
    const plain = swing(SHEET, SWORD, target, 'greatermud')!;
    const casting = swing(SHEET, { ...SWORD, hits: FROSTBITE }, target, 'greatermud')!;
    expect(plain.hitSpell).toBe(0);
    expect(casting.hitSpell).toBeCloseTo(5, 6);
    expect(swingRound(casting)! - swingRound(plain)!).toBeCloseTo(
      casting.lands.value * 5 * Math.min(6, casting.swings!.value),
      6
    );
    expect(casting.rounds!.value).toBeLessThan(plain.rounds!.value);
  });

  it('casts only from the critical blows that get past a resistance above every plain roll', () => {
    const high = swing(SHEET, SWORD, target, 'greatermud')!.range!.high;
    // Past every plain roll and half the critical range: rand(2h, 4h) above 3h does damage.
    const armoured = { ...target, damageResist: 3 * high };
    const casting = swing(SHEET, { ...SWORD, hits: FROSTBITE }, armoured, 'greatermud')!;
    const crit = casting.crit!.value;
    expect(crit).toBeGreaterThan(0);
    expect(casting.hitSpell).toBeCloseTo(crit * (high / (2 * high + 1)) * 5, 6);
  });

  it('casts nothing from a martial attack', () => {
    const kick = swing(SHEET, { ...SWORD, hits: FROSTBITE }, target, 'greatermud', {
      kind: 'kick',
      bonus: 0
    });
    expect(kick?.hitSpell ?? 0).toBe(0);
    // Positive control: the plain attack with the same weapon casts.
    expect(
      swing(SHEET, { ...SWORD, hits: FROSTBITE }, target, 'greatermud')!.hitSpell
    ).toBeGreaterThan(0);
  });
});
