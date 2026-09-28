import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../dice';
import {
  expectedHarm,
  freshMobState,
  mobModel,
  rollMobRound,
  spellEffect,
  type MobModel
} from '../mobRound';
import type { MenacePlayer } from '../menace';
import type { WorldSpell } from '../world';

/*
 * One monster's round rolled as MMUD Explorer's `RunSim` rolls it (todo 03).
 * The figures are worked from MME's loop, not from the function under test.
 */

const BARE: MenacePlayer = { armourClass: 0, damageResist: 0, magicRes: 50 };

const spear: WorldSpell = {
  id: 1,
  name: 'spear',
  targets: 8,
  abilities: [[17, 0]],
  power: [40, 40]
};

/** A model with one slot, always rolled. */
function only(slot: MobModel['slots'][number], resist = 0): MobModel {
  return { slots: [slot], casts: [], resist };
}

describe('the energy a round is paid from', () => {
  it('pays a 1,000 cast once a round, and a 500 blow twice', () => {
    const cast = only({
      kind: 'spell',
      chance: 1,
      energy: 1000,
      castChance: 1,
      effect: spellEffect(spear, 0, BARE)
    });
    const state = freshMobState();
    const random = mulberry32(1);
    // MR 50 is the pivot: the spear lands whole, once, every round.
    expect(rollMobRound(random, cast, state).harm).toBe(40);
    expect(rollMobRound(random, cast, state).harm).toBe(40);

    const blow = only({
      kind: 'melee',
      chance: 1,
      energy: 500,
      lands: 1,
      min: 7,
      max: 7,
      onHit: null
    });
    expect(rollMobRound(random, blow, freshMobState()).harm).toBe(14);
  });

  it('never swings more than six times', () => {
    const cheap = only({
      kind: 'melee',
      chance: 1,
      energy: 10,
      lands: 1,
      min: 1,
      max: 1,
      onHit: null
    });
    expect(rollMobRound(mulberry32(2), cheap, freshMobState()).harm).toBe(6);
  });

  it('charges a failed cast half, and keeps what cannot pay for another', () => {
    const fails = only({
      kind: 'spell',
      chance: 1,
      energy: 1000,
      castChance: 0,
      effect: spellEffect(spear, 0, BARE)
    });
    const state = freshMobState();
    rollMobRound(mulberry32(3), fails, state);
    // 1,000 granted, 500 for the failure, and 500 cannot pay for a second cast.
    expect(state.energy).toBe(500);
    // A lasting spell's failure costs nothing.
    const lasting = only({
      kind: 'spell',
      chance: 1,
      energy: 1000,
      castChance: 0,
      effect: { low: 5, high: 5, resist: 0, ticks: 4, held: 0, mends: null }
    });
    const kept = freshMobState();
    rollMobRound(mulberry32(3), lasting, kept);
    expect(kept.energy).toBe(1000);
    // Carried: the next round has 1,500, which pays for two failures.
    rollMobRound(mulberry32(3), fails, state);
    expect(state.energy).toBe(500);
  });

  it('takes the damage resistance off every blow', () => {
    const blow = only(
      { kind: 'melee', chance: 1, energy: 1000, lands: 1, min: 10, max: 10, onHit: null },
      4
    );
    expect(rollMobRound(mulberry32(4), blow, freshMobState()).harm).toBe(6);
  });
});

describe('what a spell does to the character', () => {
  it('scales a monster’s cast by its level, uncapped', () => {
    const grown: WorldSpell = {
      ...spear,
      power: [27, 61],
      minGrowth: [3, 1],
      maxGrowth: [2, 2],
      cap: 10
    };
    const effect = spellEffect(grown, 28, BARE)!;
    // 27 + 28/3 and 61 + 28/2 × 2, the cap not applied to a monster.
    expect([effect.low, effect.high]).toEqual([36, 89]);
  });

  it('holds the character for the rounds its ticks last', () => {
    const hold: WorldSpell = { id: 2, name: 'hold', targets: 8, duration: 4, abilities: [[74, 0]] };
    // Four three-second ticks are 2.4 five-second rounds: three whole rounds.
    expect(spellEffect(hold, 0, BARE)?.held).toBe(3);
    const model: MobModel = {
      slots: [],
      casts: [{ chance: 1, effect: spellEffect(hold, 0, BARE) }],
      resist: 0
    };
    expect(rollMobRound(mulberry32(5), model, freshMobState()).held).toBe(3);
  });

  it('mends the monster with a heal cast on itself', () => {
    const mend: WorldSpell = {
      id: 3,
      name: 'mend',
      targets: 2,
      abilities: [[18, 0]],
      power: [10, 10]
    };
    const model: MobModel = {
      slots: [],
      casts: [{ chance: 1, effect: spellEffect(mend, 0, BARE) }],
      resist: 0
    };
    const outcome = rollMobRound(mulberry32(6), model, freshMobState());
    expect(outcome.mended).toBe(10);
    expect(outcome.harm).toBe(0);
  });

  it('ticks a lasting wound the round it lands, and once more every third round', () => {
    const rot: WorldSpell = { id: 4, name: 'rot', targets: 8, duration: 10, abilities: [[1, 5]] };
    const model: MobModel = {
      slots: [],
      casts: [{ chance: 1, effect: spellEffect(rot, 0, BARE) }],
      resist: 0
    };
    const state = freshMobState();
    const random = mulberry32(7);
    expect(rollMobRound(random, model, state).harm).toBe(5);
    // Cast again at the same figure: already running, so not started over.
    expect(rollMobRound(random, model, state).harm).toBe(5);
    const once: MobModel = { ...model, casts: [] };
    expect(rollMobRound(random, once, state).harm).toBe(5);
    // Three ticks in, the fourth round takes the extra one.
    expect(rollMobRound(random, once, state).harm).toBe(10);
  });
});

describe('choosing a name’s worst row', () => {
  it('prices a spell slot beside the blows', () => {
    const subject = { spells: { 1: spear } };
    const blows = mobModel(
      subject,
      {
        attacks: [{ kind: 'melee', chance: 1, accuracy: 1000, min: 5, max: 5, energy: 1000 }],
        casts: []
      },
      BARE
    );
    const spears = mobModel(
      subject,
      {
        attacks: [{ kind: 'spell', chance: 1, spell: 1, castChance: 1, level: 0, energy: 1000 }],
        casts: []
      },
      BARE
    );
    expect(expectedHarm(spears)).toBeGreaterThan(expectedHarm(blows));
  });
});
