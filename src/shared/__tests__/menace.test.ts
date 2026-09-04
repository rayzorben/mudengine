import { describe, expect, it } from 'vitest';

import {
  expectedBlow,
  hitChance,
  magicResistance,
  rankByMenace,
  scaledPower,
  weighRoom,
  type MenacePlayer,
  type MenaceSubject,
  type MenaceWeights
} from '../menace';
import type { MobAttack, MobCast, WorldSpell } from '../world';

/*
 * The prices `internal.yaml` ships with, written out so a test reads as the
 * arithmetic it checks rather than as a lookup into the defaults.
 */
const weights: MenaceWeights = {
  held: 1,
  confused: 0.5,
  blinded: 0.5,
  slowed: 0.25,
  afraid: 1,
  summon: 2,
  teleported: 1,
  roomWide: 2,
  lastingTicks: 20,
  unitFloor: 10,
  deathOverRounds: 5
};

/** A character whose sheet nobody has read. */
const unread: MenacePlayer = { armourClass: null, damageResist: null, magicRes: null };

const blow = (over: Partial<Extract<MobAttack, { kind: 'melee' }>> = {}): MobAttack => ({
  kind: 'melee',
  chance: 1,
  accuracy: 45,
  min: 2,
  max: 11,
  energy: 1000,
  ...over
});

const fighter = (
  hp: number,
  attacks: MobAttack[],
  over: { casts?: MobCast[]; spells?: Record<number, WorldSpell>; deathSpell?: number } = {}
): MenaceSubject => ({
  hp,
  profiles: [{ attacks, casts: over.casts ?? [] }],
  ...(over.spells === undefined ? {} : { spells: over.spells }),
  ...(over.deathSpell === undefined ? {} : { deathSpell: over.deathSpell })
});

/** `hold person` as the realm states it: a single target, held for four ticks. */
const HOLD: WorldSpell = {
  id: 66,
  name: 'hold person',
  targets: 8,
  duration: 4,
  power: [100, 100],
  abilities: [[74, 0]]
};

/*
 * `Mob.DoCombat`, transcribed:
 *   tempacc = 100 - (fixedDefense² / max((Acc² / 14) / 10, 1))
 * in integer arithmetic. The figures here were worked by hand from the
 * server's own lines, not from the function under test.
 */
describe('whether a blow lands', () => {
  it('rolls the sheet’s armour class against the slot’s accuracy as the server does', () => {
    // (45² / 14) / 10 = 14; 20² / 14 = 28; 100 − 28.
    expect(hitChance(45, 20)).toBe(0.72);
    // (80² / 14) / 10 = 45; 30² / 45 = 20.
    expect(hitChance(80, 30)).toBe(0.8);
  });

  it('cannot go below never', () => {
    // A rat’s accuracy of 10 reaches nothing: (100 / 14) / 10 = 0, floored to 1,
    // and 400 / 1 is far past 100.
    expect(hitChance(10, 20)).toBe(0);
  });

  /* Unknown is never the reassuring answer: a sheet nobody has read makes
     every blow land. */
  it('treats an unread armour class as none', () => {
    expect(hitChance(45, null)).toBe(1);
  });
});

describe('what a blow does through damage resistance', () => {
  it('is the mean of the range when nothing is resisted', () => {
    expect(expectedBlow(2, 10, null)).toEqual({ damage: 6, lands: 1 });
  });

  /* The mean is over the blows that get through, not the mean minus the
     resistance: `rand(2, 10) - 5` is 1–5 on five of nine rolls and nothing
     on the other four, and a blow that comes to nothing applies no hit
     spell either. */
  it('counts only the blows that get through, and says how many do', () => {
    const { damage, lands } = expectedBlow(2, 10, 5);
    expect(damage).toBeCloseTo(15 / 9, 6);
    expect(lands).toBeCloseTo(5 / 9, 6);
  });

  it('is nothing when the resistance covers the whole range', () => {
    expect(expectedBlow(2, 10, 10)).toEqual({ damage: 0, lands: 0 });
  });

  it('reads a range stated backwards', () => {
    expect(expectedBlow(10, 2, null)).toEqual({ damage: 6, lands: 1 });
  });
});

describe('a spell’s power at a cast level', () => {
  const spell: WorldSpell = {
    id: 1,
    name: 'bolt',
    power: [4, 14],
    minGrowth: [2, 1],
    maxGrowth: [2, 1],
    cap: 10
  };

  it('grows per level step and stops at the cap', () => {
    expect(scaledPower(spell, 20)).toEqual([9, 19]);
  });

  it('truncates a partial step, as the server does', () => {
    expect(scaledPower(spell, 3)).toEqual([5, 15]);
  });

  it('is the base where the realm states no growth, and nothing where it states no power', () => {
    expect(scaledPower({ id: 1, name: 'x', power: [3, 3] }, 50)).toEqual([3, 3]);
    expect(scaledPower({ id: 1, name: 'x' }, 50)).toEqual([0, 0]);
  });
});

/*
 * `Spell.GetMagicResModifierVsTarget`: the modifier is 1 − (MR − 50) / 100 with
 * the resistance clamped to 0–150, and the resist roll is the complement of
 * it, rolled only for a spell the realm marks resistable by anyone.
 */
describe('what magic resistance turns away', () => {
  it('thins a resistable cast and gives it a chance of being refused outright', () => {
    expect(magicResistance({ id: 1, name: 'x', resist: 2 }, 65)).toEqual({
      factor: 0.85,
      resist: expect.closeTo(0.15, 6) as number
    });
  });

  it('thins a cast nothing can refuse, and refuses none of it', () => {
    expect(magicResistance({ id: 1, name: 'x' }, 65)).toEqual({ factor: 0.85, resist: 0 });
  });

  it('is exempt for a bite or a breath the realm marks non-magical', () => {
    expect(magicResistance({ id: 1, name: 'x', resist: 2, abilities: [[144, 0]] }, 65)).toEqual({
      factor: 1,
      resist: 0
    });
  });

  /* Below the pivot the server deals *more* than the spell states, and an
     unread figure is taken at the end that lets the most through. */
  it('lets more through below the pivot, and treats an unread figure as none', () => {
    expect(magicResistance({ id: 1, name: 'x' }, 0)).toEqual({ factor: 1.5, resist: 0 });
    expect(magicResistance({ id: 1, name: 'x' }, null)).toEqual({ factor: 1.5, resist: 0 });
  });

  it('clamps at the ceiling', () => {
    expect(magicResistance({ id: 1, name: 'x', resist: 2 }, 200)).toEqual({ factor: 0, resist: 1 });
  });
});

describe('weighing a room', () => {
  it('prices a blow as the server rolls it, against the sheet', () => {
    const [thug] = weighRoom(
      [fighter(28, [blow()])],
      { armourClass: 20, damageResist: null, magicRes: null },
      weights
    );
    // 72% of a 6.5 mean, once a round.
    expect(thug?.blows).toBeCloseTo(4.68, 6);
    expect(thug?.perRound).toBeCloseTo(4.68, 6);
    expect(thug?.weight).toBeCloseTo(4.68 / 28, 6);
    expect(thug?.hazards).toEqual([]);
  });

  /* 1,000 energy a round: a 666-energy bite lands one and a half times. */
  it('swings as often as the energy grant allows', () => {
    const [thief] = weighRoom(
      [fighter(20, [blow({ accuracy: 15, min: 1, max: 8, energy: 666 })])],
      unread,
      weights
    );
    expect(thief?.perRound).toBeCloseTo((1000 / 666) * 4.5, 6);
  });

  /*
   * The reason profiles are carried per row: which row is worst depends on
   * the armour class in front of it. A clumsy heavy hitter is the worse row
   * for an unarmoured character and the harmless one for an armoured one.
   */
  it('folds to the row that is worst for this character, not for a character in general', () => {
    const twoRows: MenaceSubject = {
      hp: 50,
      profiles: [
        { attacks: [blow({ accuracy: 20, min: 20, max: 20 })], casts: [] },
        { attacks: [blow({ accuracy: 200, min: 5, max: 5 })], casts: [] }
      ]
    };
    expect(weighRoom([twoRows], unread, weights)[0]?.perRound).toBe(20);
    // At AC 40 the clumsy row never lands: (20² / 14) / 10 = 2, 1600 / 2 ≫ 100.
    // The accurate one lands 95 times in 100: (200² / 14) / 10 = 285, 1600 / 285 = 5.
    expect(
      weighRoom([twoRows], { armourClass: 40, damageResist: null, magicRes: null }, weights)[0]
        ?.perRound
    ).toBeCloseTo(4.75, 6);
  });

  it('prices a round held in rounds of the whole room’s blows', () => {
    const priest = fighter(100, [], {
      casts: [{ spell: 66, chance: 1, level: 12 }],
      spells: { 66: HOLD }
    });
    const thug = fighter(28, [blow()]);
    const [held, bitten] = weighRoom([priest, thug], unread, weights);
    // The room lands 6.5 a round, under the ten-point floor; four ticks of
    // three seconds are 2.4 rounds of five; held costs one round each.
    expect(held?.perRound).toBeCloseTo(24, 6);
    expect(held?.blows).toBe(0);
    expect(held?.hazards).toEqual(['held']);
    expect(bitten?.perRound).toBeCloseTo(6.5, 6);
    // 24 / 100 outranks 6.5 / 28.
    expect(rankByMenace([held ?? null, bitten ?? null])).toEqual([0, 1]);
    // And the price is a setting: at half a round, the thug comes first.
    const cheaper = weighRoom([priest, thug], unread, { ...weights, held: 0.5 });
    expect(rankByMenace(cheaper)).toEqual([1, 0]);
  });

  it('multiplies a spell that reaches everybody in the room', () => {
    const [caster] = weighRoom(
      [
        fighter(100, [], {
          casts: [{ spell: 66, chance: 1, level: 12 }],
          spells: { 66: { ...HOLD, targets: 12 } }
        })
      ],
      unread,
      weights
    );
    expect(caster?.perRound).toBeCloseTo(48, 6);
    expect(caster?.wide).toBe(true);
  });

  it('charges nothing for a monster buffing itself, and a summon whoever it names', () => {
    const [buffing, summoning] = weighRoom(
      [
        fighter(100, [], {
          casts: [{ spell: 66, chance: 1, level: 12 }],
          spells: { 66: { ...HOLD, targets: 1 } }
        }),
        fighter(100, [], {
          casts: [{ spell: 888, chance: 1, level: 1 }],
          spells: { 888: { id: 888, name: 'calls for aid', targets: 1, abilities: [[12, 13]] } }
        })
      ],
      unread,
      weights
    );
    expect(buffing?.perRound).toBe(0);
    expect(summoning?.perRound).toBe(20);
    expect(summoning?.hazards).toEqual(['summon']);
  });

  /* `Hit(value)` on the cast and on every effect tick — bounded, because a
     hundred ticks is five minutes and nobody stands in that. */
  it('counts a lasting damage spell per tick, up to the bound', () => {
    const rotting: WorldSpell = {
      id: 143,
      name: 'rotting flesh',
      targets: 8,
      duration: 10,
      power: [6, 6],
      abilities: [[1, 0]]
    };
    const [short, long] = weighRoom(
      [
        fighter(100, [], {
          casts: [{ spell: 143, chance: 1, level: 1 }],
          spells: { 143: rotting }
        }),
        fighter(100, [], {
          casts: [{ spell: 143, chance: 1, level: 1 }],
          spells: { 143: { ...rotting, duration: 100 } }
        })
      ],
      unread,
      weights
    );
    expect(short?.perRound).toBe(66);
    expect(long?.perRound).toBe(126);
    expect(short?.hazards).toEqual(['damage']);
  });

  it('thins a resistable cast by the sheet’s magic resistance, and not a bite', () => {
    const bolt: WorldSpell = {
      id: 1,
      name: 'bolt',
      targets: 8,
      power: [20, 20],
      resist: 2,
      abilities: [[17, 0]]
    };
    const bite: WorldSpell = {
      ...bolt,
      abilities: [
        [17, 0],
        [144, 0]
      ]
    };
    const [magical, mundane] = weighRoom(
      [
        fighter(100, [], { casts: [{ spell: 1, chance: 1, level: 1 }], spells: { 1: bolt } }),
        fighter(100, [], { casts: [{ spell: 1, chance: 1, level: 1 }], spells: { 1: bite } })
      ],
      { armourClass: null, damageResist: null, magicRes: 65 },
      weights
    );
    expect(magical?.perRound).toBeCloseTo(20 * 0.85 * 0.85, 6);
    expect(mundane?.perRound).toBe(20);
  });

  /* A hit spell rides on a blow that did damage: 72% land, and five of nine
     of those get through the resistance. */
  it('lets an on-hit spell ride only on the blows that get through', () => {
    const knockdown: WorldSpell = {
      id: 318,
      name: 'knockdown',
      targets: 8,
      duration: 4,
      abilities: [
        [74, 1],
        [144, 0]
      ]
    };
    const [biter] = weighRoom(
      [fighter(40, [blow({ min: 2, max: 10, onHit: 318 })], { spells: { 318: knockdown } })],
      { armourClass: 20, damageResist: 5, magicRes: null },
      weights
    );
    expect(biter?.blows).toBeCloseTo(0.72 * (15 / 9), 6);
    expect(biter?.perRound).toBeCloseTo(0.72 * (15 / 9) + 0.72 * (5 / 9) * 24, 6);
    expect(biter?.hazards).toEqual(['held']);
  });

  it('counts a cast in a blow’s place by its own odds', () => {
    const [caster] = weighRoom(
      [
        fighter(
          100,
          [
            {
              kind: 'spell',
              chance: 0.5,
              spell: 66,
              castChance: 0.8,
              level: 12,
              energy: 1000
            },
            blow({ chance: 0.5, min: 10, max: 10 })
          ],
          { spells: { 66: HOLD } }
        )
      ],
      unread,
      weights
    );
    // Half the swings are a blow of 10 (the room's blood is 5, floored to
    // 10), half are an 80% cast of a 24-point hold.
    expect(caster?.perRound).toBeCloseTo(0.5 * 10 + 0.5 * 0.8 * 24, 6);
  });

  it('spreads a death spell over the rounds a kill takes', () => {
    const explosion: WorldSpell = {
      id: 751,
      name: 'demon explosion',
      targets: 12,
      power: [100, 200],
      abilities: [[17, 0]]
    };
    const [demon] = weighRoom(
      [fighter(100, [blow({ min: 10, max: 10 })], { deathSpell: 751, spells: { 751: explosion } })],
      unread,
      weights
    );
    // 150 mean, ×1.5 below the resistance pivot, ×2 room-wide.
    expect(demon?.onDeath).toBeCloseTo(450, 6);
    expect(demon?.perRound).toBeCloseTo(10 + 450 / 5, 6);
    expect(demon?.wide).toBe(true);
    expect(demon?.hazards).toEqual(['damage']);
  });

  /* Two different absences: a realm that says nothing, and a realm that
     says this one fights with nothing. */
  it('is null where the realm does not say, and nothing where it says nothing fights', () => {
    const [unknown, harmless] = weighRoom([{}, { hp: 10, profiles: [] }], unread, weights);
    expect(unknown).toBeNull();
    expect(harmless?.weight).toBe(0);
  });

  it('weighs a monster whose spell the realm cannot name by its blows alone', () => {
    const [caster] = weighRoom(
      [fighter(100, [blow({ min: 4, max: 4 })], { casts: [{ spell: 9999, chance: 1, level: 1 }] })],
      unread,
      weights
    );
    expect(caster?.perRound).toBe(4);
  });
});

/*
 * Smith's rule, and the reason the order is rate over health: the small
 * monster is removed in a round or two and stops costing anything, where the
 * big one is thirty rounds of taking both.
 */
describe('which to hit first', () => {
  it('ends the fight that costs most per hit point, not the biggest hitter', () => {
    const ogre = fighter(3000, [blow({ min: 40, max: 60 })]);
    const rat = fighter(100, [blow({ min: 25, max: 35 })]);
    expect(rankByMenace(weighRoom([ogre, rat], unread, weights))).toEqual([1, 0]);
  });

  it('puts what the realm cannot weigh first, and keeps the given order among equals', () => {
    expect(
      rankByMenace([
        { perRound: 2, blows: 2, onDeath: 0, hp: 10, weight: 0.2, hazards: [], wide: false },
        null,
        { perRound: 5, blows: 5, onDeath: 0, hp: 10, weight: 0.5, hazards: [], wide: false },
        { perRound: 5, blows: 5, onDeath: 0, hp: 10, weight: 0.5, hazards: [], wide: false }
      ])
    ).toEqual([1, 2, 3, 0]);
  });
});
