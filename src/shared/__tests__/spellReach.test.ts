import { describe, expect, it } from 'vitest';

import { SPELL_REACH_ABILITY as A } from '../abilities';
import { natureOf, spellReaches, type MonsterNature } from '../spellReach';
import type { WorldSpell } from '../world';

/* The three spells a Priest has by level 4 on Paradigm's data (gmud.zip). */
const HARM: WorldSpell = {
  id: 12,
  name: 'harm',
  level: 1,
  targets: 8,
  abilities: [
    [17, 0],
    [A.affectsLiving, 0]
  ]
};
const TURN_UNDEAD: WorldSpell = {
  id: 18,
  name: 'turn undead',
  level: 3,
  targets: 4,
  abilities: [
    [1, 0],
    [A.affectsUndead, 0]
  ]
};
const HAMMER: WorldSpell = {
  id: 16,
  name: 'spiritual hammer',
  level: 4,
  targets: 8,
  abilities: [[17, 0]]
};

const nature = (over: Partial<MonsterNature> = {}): MonsterNature => ({
  nonLiving: false,
  animal: false,
  undead: false,
  spellImmunity: [0, 0],
  ...over
});

/* A `zombie`'s rows on gmud.zip: all three undead and `NonLiving 0`. */
const ZOMBIE = natureOf(
  [-100, -50, -35].map((fire) => ({
    abilities: [
      [5, fire],
      [A.nonLiving, 0]
    ] as Array<[number, number]>,
    undead: true
  }))
);

describe('what the server lets a spell touch', () => {
  it('reads a name whose rows agree as the rows', () => {
    expect(ZOMBIE).toEqual({
      nonLiving: true,
      animal: false,
      undead: true,
      spellImmunity: [0, 0]
    });
  });

  it('keeps a name whose rows disagree unsaid', () => {
    const elemental = natureOf([
      { abilities: [[A.nonLiving, 0]], undead: false },
      { abilities: [[A.animal, 0]], undead: false }
    ]);
    expect(elemental.nonLiving).toBeNull();
    expect(elemental.animal).toBeNull();
    expect(elemental.undead).toBe(false);
    // A row the file carries no effects for says nothing about any of them.
    expect(natureOf([{ undead: true }, { abilities: [], undead: true }])).toMatchObject({
      nonLiving: null,
      undead: true,
      spellImmunity: null
    });
  });

  it('says harm has no effect on a zombie, and that the other two do', () => {
    expect(spellReaches(HARM, ZOMBIE)).toBe(false);
    expect(spellReaches(TURN_UNDEAD, ZOMBIE)).toBe(true);
    expect(spellReaches(HAMMER, ZOMBIE)).toBe(true);
  });

  it('says turn undead has no effect on the living, and harm does', () => {
    expect(spellReaches(TURN_UNDEAD, nature())).toBe(false);
    expect(spellReaches(HARM, nature())).toBe(true);
  });

  it('says nothing where the rows disagree or the realm is silent', () => {
    expect(spellReaches(HARM, nature({ nonLiving: null }))).toBeNull();
    expect(spellReaches(HARM, undefined)).toBeNull();
    // A no from any rule outranks a doubt in another.
    expect(spellReaches(TURN_UNDEAD, nature({ undead: false, spellImmunity: null }))).toBe(false);
  });

  it('stops a spell whose level is under the immunity, unless it fills the room', () => {
    const room: WorldSpell = { ...HAMMER, targets: 12 };
    expect(spellReaches(HAMMER, nature({ spellImmunity: [20, 20] }))).toBe(false);
    expect(spellReaches(room, nature({ spellImmunity: [20, 20] }))).toBe(true);
    expect(spellReaches(HAMMER, nature({ spellImmunity: [0, 20] }))).toBeNull();
    expect(spellReaches(HAMMER, nature({ spellImmunity: [4, 4] }))).toBe(true);
    // No immunity stops nothing, whatever the spell's level says.
    expect(spellReaches({ id: 1, name: 'unlevelled' }, nature())).toBe(true);
    // 999 stops every spell, the room's too.
    expect(spellReaches(room, nature({ spellImmunity: [999, 999] }))).toBe(false);
  });

  it('reads an animals-only spell against the animal flag', () => {
    const charm: WorldSpell = {
      id: 90,
      name: 'charm beast',
      level: 1,
      abilities: [[A.affectsAnimals, 0]]
    };
    expect(spellReaches(charm, nature({ animal: true }))).toBe(true);
    expect(spellReaches(charm, nature())).toBe(false);
  });
});
