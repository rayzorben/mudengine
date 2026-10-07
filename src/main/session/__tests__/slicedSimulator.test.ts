import { describe, expect, it } from 'vitest';

import { SlicedSimulator } from '../slicedSimulator';
import { simulateFight, type Survival, type SurvivalInput } from '../../../shared/survival';
import type { MobEntity } from '../../../shared/entities';

/* Fights run on the asking thread, in slices, answered in the order asked. */
const ogre = {
  name: 'ogre',
  source: 'realm',
  hp: 30,
  profiles: [
    {
      attacks: [{ kind: 'melee' as const, chance: 1, accuracy: 50, min: 1, max: 2, energy: 1000 }],
      casts: []
    }
  ]
} as unknown as MobEntity;

const INPUT = {
  hp: 100,
  hpMax: 100,
  mana: 0,
  manaMax: 0,
  player: { armourClass: 10, damageResist: 0, magicRes: 50 },
  sheet: {
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
  },
  weapon: { min: 5, max: 12, speed: 20, strength: 30 },
  family: 'greatermud',
  weights: {
    held: 1,
    confused: 1,
    blinded: 1,
    slowed: 1,
    afraid: 1,
    summon: 1,
    teleported: 1,
    roomWide: 1,
    lastingTicks: 20,
    unitFloor: 10,
    deathOverRounds: 5
  },
  heal: null,
  regenPerRound: 0,
  recasts: [],
  levels: { safeAbove: 0.6, riskyAbove: 0.25 },
  trials: 40,
  roundCap: 50,
  horizons: [1, 3],
  foes: [{ name: 'ogre', subject: ogre }],
  casting: [null]
} as unknown as SurvivalInput;

describe('fights run in slices', () => {
  it('answers what simulateFight answers, in the order asked, null for no fight', async () => {
    const simulator = new SlicedSimulator();
    const answers: Array<Survival | null> = [];
    simulator.run(INPUT, (survival) => answers.push(survival));
    simulator.run({ ...INPUT, foes: [] }, (survival) => answers.push(survival));
    await new Promise<void>((done) => simulator.run(INPUT, () => done()));
    expect(answers).toEqual([simulateFight(INPUT), null]);
  });

  it('never answers a run that was dropped', async () => {
    const simulator = new SlicedSimulator();
    const answered: string[] = [];
    const drop = simulator.run(INPUT, () => answered.push('dropped'));
    drop();
    // Positive control: a run asked after it is answered, so the dropped one had its turn.
    await new Promise<void>((done) =>
      simulator.run(INPUT, () => {
        answered.push('kept');
        done();
      })
    );
    expect(answered).toEqual(['kept']);
  });
});
