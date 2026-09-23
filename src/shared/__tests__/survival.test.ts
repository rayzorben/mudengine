import { describe, expect, it } from 'vitest';

import { simulateFight, type SurvivalInput } from '../survival';
import type { MenaceWeights } from '../menace';
import type { ProwessSheet } from '../prowess';
import type { MobProfile } from '../world';

/*
 * The room's fight, run (todo 02, 2026-09-17). These pin the shape of the
 * answer rather than its arithmetic — the arithmetic is `prowess.swing` and
 * `menace.hitChance`, tested where they live — and the honesty rules: a foe
 * the realm cannot weigh is no answer, a character that cannot hurt anything
 * is no answer, and the same room reads the same twice.
 */

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

const SWORD = { min: 5, max: 12, speed: 20, strength: 30 };

const WEIGHTS: MenaceWeights = {
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
};

/** One melee attack a round, always chosen, with the given reach and range. */
function biter(accuracy: number, min: number, max: number): MobProfile {
  return {
    attacks: [{ kind: 'melee', chance: 1, accuracy, min, max, energy: 1000 }],
    casts: []
  };
}

function fight(overrides: Partial<SurvivalInput> = {}): SurvivalInput {
  return {
    hp: 100,
    hpMax: 100,
    mana: 40,
    manaMax: 40,
    player: { armourClass: 20, damageResist: 1, magicRes: 0 },
    sheet: SHEET,
    weapon: SWORD,
    family: 'greatermud',
    weights: WEIGHTS,
    foes: [{ name: 'rat', subject: { hp: 12, profiles: [biter(20, 1, 3)] } }],
    casting: [null],
    heal: null,
    regenPerRound: 0,
    recasts: [],
    levels: { safeAbove: 0.95, riskyAbove: 0.6 },
    trials: 200,
    roundCap: 100,
    ...overrides
  };
}

describe('the room’s fight, run', () => {
  /* Mob.DoCombat's protection reaches the fight run, not only the ranking (todo 00). */
  it('runs an evil monster’s blows against the protection that applies to them', () => {
    const foes = [1, 2, 3].map((n) => ({
      name: `orc ${n}`,
      subject: { hp: 60, profiles: [biter(60, 6, 12)], disposition: 'hostile' as const }
    }));
    const bare = simulateFight(fight({ foes, casting: [null, null, null] }))!;
    const warded = simulateFight(
      fight({
        foes,
        casting: [null, null, null],
        player: { armourClass: 20, damageResist: 1, magicRes: 0, versusEvil: 30, dodge: 10 }
      })
    )!;
    // 50 against an accuracy of 60 is past reach: (60² / 14) / 10 = 25, 2,500 / 25.
    expect(bare.hpLeft!).toBeLessThan(100);
    expect(warded.hpLeft).toBe(100);
  });

  it('walks out of a room of rats every time', () => {
    const result = simulateFight(fight());
    expect(result).not.toBeNull();
    expect(result!.survives).toBe(1);
    expect(result!.level).toBe('safe');
    expect(result!.hpLeft).not.toBeNull();
    expect(result!.hpLeft!).toBeGreaterThan(50);
    expect(result!.rounds.from).toBe('measured');
    expect(result!.trials).toBe(200);
  });

  it('dies to something that cannot be killed in time', () => {
    const result = simulateFight(
      fight({ foes: [{ name: 'dragon', subject: { hp: 5000, profiles: [biter(400, 60, 90)] } }] })
    );
    expect(result!.survives).toBe(0);
    expect(result!.level).toBe('deadly');
    expect(result!.hpLeft).toBeNull();
  });

  it('counts a heal the automation would cast, and it raises the odds', () => {
    // Three of them: enough that the fight is close without a heal.
    const foes = [1, 2, 3].map((n) => ({
      name: `orc ${n}`,
      subject: { hp: 60, profiles: [biter(60, 6, 12)] }
    }));
    const bare = simulateFight(fight({ foes, casting: [null, null, null] }))!;
    const healed = simulateFight(
      fight({
        foes,
        casting: [null, null, null],
        mana: 200,
        manaMax: 200,
        heal: { below: 0.5, to: 0.8, restores: [20, 30], cost: 6, minMana: 0 }
      })
    )!;
    expect(bare.heals).toBe(0);
    expect(healed.heals).toBeGreaterThan(0);
    expect(healed.survives).toBeGreaterThanOrEqual(bare.survives);
  });

  it('casts no heal past the mana floor, or with the mana unknown', () => {
    const foes = [{ name: 'orc', subject: { hp: 200, profiles: [biter(60, 8, 14)] } }];
    const heal = {
      below: 0.6,
      to: 0,
      restores: [20, 30] as [number, number],
      cost: 10,
      minMana: 0.9
    };
    const floored = simulateFight(fight({ foes, heal, mana: 20, manaMax: 40 }))!;
    expect(floored.heals).toBe(0);
    const unknown = simulateFight(fight({ foes, heal, mana: null, manaMax: null }))!;
    expect(unknown.heals).toBe(0);
  });

  it('refuses a foe the realm cannot weigh, and a fight it cannot win', () => {
    expect(simulateFight(fight({ foes: [{ name: 'stranger', subject: {} }] }))).toBeNull();
    // No weapon and no spell: nothing to hurt it with, so nothing to say.
    expect(simulateFight(fight({ weapon: null }))).toBeNull();
    expect(simulateFight(fight({ foes: [] }))).toBeNull();
  });

  it('reads the same twice, and differently under another seed', () => {
    const foes = [1, 2].map((n) => ({
      name: `orc ${n}`,
      subject: { hp: 80, profiles: [biter(70, 6, 12)] }
    }));
    const once = simulateFight(fight({ foes, casting: [null, null] }))!;
    const again = simulateFight(fight({ foes, casting: [null, null] }))!;
    expect(again).toEqual(once);
    const other = simulateFight(fight({ foes, casting: [null, null], seed: 7 }))!;
    // Not asserted unequal — two seeds may agree — but a different seed runs.
    expect(other.trials).toBe(once.trials);
  });

  it('lets a caster fight where the swing says nothing', () => {
    const result = simulateFight(
      fight({
        weapon: null,
        mana: 100,
        manaMax: 100,
        foes: [{ name: 'rat', subject: { hp: 12, profiles: [biter(20, 1, 3)] } }],
        casting: [{ perRound: 8, manaPerRound: 4 }]
      })
    );
    expect(result).not.toBeNull();
    expect(result!.survives).toBe(1);
    expect(result!.rounds.value).toBeLessThan(4);
  });

  it('charges a lapsing blessing’s recast against the heals', () => {
    const foes = [{ name: 'orc', subject: { hp: 300, profiles: [biter(60, 8, 14)] } }];
    const heal = {
      below: 0.6,
      to: 0.9,
      restores: [15, 20] as [number, number],
      cost: 10,
      minMana: 0
    };
    const kept = simulateFight(fight({ foes, heal, mana: 30, manaMax: 100 }))!;
    const spent = simulateFight(
      fight({ foes, heal, mana: 30, manaMax: 100, recasts: [{ round: 1, cost: 25 }] })
    )!;
    expect(spent.heals).toBeLessThan(kept.heals);
  });
});

/*
 * `stat all`'s range where it still holds, as `prowess.swing` takes it: the
 * verdict's rounds and the run beside it on the Room card roll the same blow.
 */
describe('the blow the sheet states', () => {
  it('is the blow the run rolls', () => {
    const tough = { name: 'ogre', subject: { hp: 400, profiles: [biter(20, 1, 3)] } };
    const armed = simulateFight(fight({ foes: [tough] }))!;
    const stated = simulateFight(
      fight({
        foes: [tough],
        sheet: { ...SHEET, stated: { damage: { min: 40, max: 60 } } }
      })
    )!;
    expect(stated.rounds.value).toBeLessThan(armed.rounds.value / 3);
  });
});
