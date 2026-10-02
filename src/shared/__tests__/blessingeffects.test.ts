import { describe, expect, it } from 'vitest';

import {
  bareStateOf,
  blessedPlayer,
  effectOf,
  effectsUp,
  exclusive,
  NO_EFFECT,
  sumEffects
} from '../blessingeffects';
import { EMPTY_CHARACTER } from '../character';
import { abilityValueAt, protectionOf } from '../menace';
import { accuracy, critChance, dodge, regeneration, swing, type ProwessSheet } from '../prowess';
import type { WorldSpell } from '../world';

/*
 * Rows as the gmud.zip conversion carries them (format 49, 2026-10-01):
 * ability pairs, power and its growth, as `indexSpells` writes them.
 */
const OWL: WorldSpell = {
  id: 37,
  name: 'way of the owl',
  short: 'owl',
  level: 3,
  mana: 2,
  duration: 60,
  targets: 1,
  abilities: [
    [36, 0],
    [115, 8546]
  ],
  power: [10, 10],
  cap: 114
};
const TIGER: WorldSpell = {
  id: 38,
  name: 'way of the tiger',
  short: 'tige',
  level: 5,
  mana: 3,
  duration: 60,
  targets: 1,
  difficulty: 100,
  abilities: [
    [4, 0],
    [115, 8547],
    [89, 0],
    [90, 0],
    [91, 0]
  ],
  power: [2, 2],
  cap: 30,
  minGrowth: [10, 1],
  maxGrowth: [10, 1]
};
const MONKEY: WorldSpell = {
  id: 105,
  name: 'way of the monkey',
  short: 'monk',
  level: 9,
  mana: 3,
  duration: 40,
  targets: 1,
  abilities: [
    [34, 0],
    [115, 8559],
    [2, 1]
  ],
  cap: 40,
  minGrowth: [4, 1],
  maxGrowth: [4, 1]
};
const TORTOISE: WorldSpell = {
  id: 297,
  name: 'way of the tortoise',
  short: 'tort',
  level: 12,
  mana: 3,
  duration: 45,
  targets: 1,
  abilities: [
    [7, 0],
    [115, 589]
  ],
  power: [20, 20],
  cap: 30
};
const MANTIS: WorldSpell = {
  id: 106,
  name: 'way of the mantis',
  short: 'mant',
  level: 10,
  mana: 6,
  duration: 20,
  targets: 1,
  abilities: [
    [87, 85],
    [115, 8537],
    [122, 59],
    [122, 282]
  ],
  power: [85, 85],
  cap: 32
};
const HASTE: WorldSpell = { id: 59, name: 'haste', abilities: [[87, 20]] };

describe('a blessing read as the simulator reads it', () => {
  it('fills a zero row from the power at the level, and sums repeated rows', () => {
    expect(abilityValueAt(OWL, 36, 10)).toBe(10);
    expect(abilityValueAt(TIGER, 4, 10)).toBe(3);
    expect(abilityValueAt(OWL, 2, 10)).toBeNull();
    const twice: WorldSpell = {
      id: 1,
      name: 'x',
      abilities: [
        [2, 5],
        [2, 7]
      ]
    };
    expect(abilityValueAt(twice, 2, 10)).toBe(12);
  });

  it('reads each Kai way at level 10', () => {
    expect(effectOf(OWL, 10)).toMatchObject({ magicRes: 10, armourClass: 0 });
    expect(effectOf(TIGER, 10)).toMatchObject({
      maxDamage: 3,
      martialAccuracy: { punch: 3, kick: 3, jumpkick: 3 },
      accuracy: 0
    });
    // Monkey's dodge has no base power, only growth: 10 / 4 levels, truncated.
    expect(effectOf(MONKEY, 10)).toMatchObject({ dodge: 2, armourClass: 0.1 });
    // DR is internal points; the sheet prints a tenth.
    expect(effectOf(TORTOISE, 10)).toMatchObject({ damageResist: 2 });
  });

  it('weighs nothing for a spell that only moves what is not simulated', () => {
    expect(effectOf(MANTIS, 10)).toBeNull();
  });

  it('sums a set and says null for nothing', () => {
    const owl = effectOf(OWL, 10)!;
    const tortoise = effectOf(TORTOISE, 10)!;
    expect(sumEffects([owl, tortoise])).toMatchObject({ magicRes: 10, damageResist: 2 });
    expect(sumEffects([])).toBeNull();
    expect(sumEffects([NO_EFFECT])).toBeNull();
  });

  it('knows two spells that take each other off', () => {
    expect(exclusive(MANTIS, HASTE)).toBe(true);
    expect(exclusive(HASTE, MANTIS)).toBe(true);
    expect(exclusive(MANTIS, OWL)).toBe(false);
  });

  it('reads what is up off the buffs, by the realm row', () => {
    const named = (name: string): WorldSpell | null =>
      [OWL, TORTOISE].find((spell) => spell.name === name) ?? null;
    expect(
      effectsUp([{ spell: 'way of the owl' }, { spell: 'unheard of' }], named, 10)
    ).toMatchObject({ magicRes: 10 });
    expect(effectsUp([], named, 10)).toBeNull();
  });

  it('meets a monster with the armour, resistances and dodge a set adds, unread kept unread', () => {
    const effect = sumEffects([
      effectOf(OWL, 10)!,
      effectOf(MONKEY, 10)!,
      effectOf(TORTOISE, 10)!
    ])!;
    expect(
      blessedPlayer({ armourClass: 20, damageResist: 3, magicRes: null, dodge: 5 }, effect)
    ).toEqual({ armourClass: 20.1, damageResist: 5, magicRes: null, dodge: 7 });
  });

  it('takes what is up off the printed figures for the bare character', () => {
    const named = (name: string): WorldSpell | null =>
      [OWL, TORTOISE].find((spell) => spell.name === name) ?? null;
    const state = {
      ...EMPTY_CHARACTER,
      vitals: { ...EMPTY_CHARACTER.vitals, hpMax: 100 },
      progress: {
        ...EMPTY_CHARACTER.progress,
        level: 10,
        armourClass: 20,
        damageResist: 5,
        magicRes: 60
      },
      buffs: [
        { spell: 'way of the owl', by: null, appliedAt: 0 },
        { spell: 'way of the tortoise', by: null, appliedAt: 0 }
      ]
    };
    const bare = bareStateOf(state, named);
    expect(bare.progress).toMatchObject({ armourClass: 20, damageResist: 3, magicRes: 50 });
    expect(bare.vitals.hpMax).toBe(100);
    expect(bare.buffs).toEqual([]);
    expect(bare.stated).toBeNull();
  });

  it('keeps the protection reading it shared', () => {
    const prev: WorldSpell = { id: 9, name: 'prot', abilities: [[24, 0]], power: [4, 4] };
    const state = {
      buffs: [{ spell: 'prot', appliedAt: 0 }],
      party: { members: [] },
      name: 'Soul',
      fullName: null,
      progress: { level: 10 }
    } as unknown as Parameters<typeof protectionOf>[0];
    expect(protectionOf(state, (name) => (name === 'prot' ? prev : null)).versusEvil).toBe(4);
  });
});

/** A level-10 fighter with ordinary stats, every input read. */
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

describe('a blessing reaches the formulas, never a stated figure', () => {
  const tiger = effectOf(TIGER, 10)!;
  const blessed = {
    ...SHEET,
    effects: sumEffects([tiger, { ...tiger, accuracy: 12, crits: 4, dodge: 3, hpRegen: 50 }])
  };

  it('moves accuracy, dodge, crits and regeneration on the formula sheet', () => {
    expect(accuracy(blessed, null, 'greatermud')!.value).toBeGreaterThan(
      accuracy(SHEET, null, 'greatermud')!.value
    );
    expect(dodge(blessed, 'greatermud')!.value).toBe(dodge(SHEET, 'greatermud')!.value + 3);
    expect(critChance(blessed, 'attack', 'greatermud')!.value).toBeCloseTo(
      critChance(SHEET, 'attack', 'greatermud')!.value + 0.04
    );
    expect(regeneration(blessed, null, 'greatermud')!.health.value).toBeGreaterThan(
      regeneration(SHEET, null, 'greatermud')!.health.value
    );
  });

  it('tops the blow, and the martial aim only for a martial attack', () => {
    const target = { armourClass: 10, damageResist: 0, dodge: null, health: 100 };
    const plain = swing(SHEET, null, target, 'greatermud')!;
    const more = swing({ ...SHEET, effects: tiger }, null, target, 'greatermud')!;
    expect(more.range!.high).toBe(plain.range!.high + 3);
    expect(more.lands.value).toBe(plain.lands.value);
    const kick = { kind: 'kick' as const, bonus: 0 };
    expect(
      swing({ ...SHEET, effects: tiger }, null, target, 'greatermud', kick)!.lands.value
    ).toBeGreaterThan(swing(SHEET, null, target, 'greatermud', kick)!.lands.value);
  });

  it('leaves a stated figure as stated', () => {
    const stated = { ...blessed, stated: { accuracy: 77 } };
    expect(accuracy(stated, null, 'greatermud')).toEqual({ value: 77, from: 'stated' });
  });
});
