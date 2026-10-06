import { describe, expect, it } from 'vitest';

import { NO_EFFECT } from '../blessingeffects';
import { simulateFight, startFight, type Survival, type SurvivalInput } from '../survival';
import type { MenaceWeights } from '../menace';
import type { ProwessSheet } from '../prowess';
import type { MobProfile, WorldSpell } from '../world';

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
        heal: { below: 0.5, to: 0.8, restores: [20, 30], cost: 6, minMana: 0, chosenMends: null }
      })
    )!;
    expect(bare.heals).toBe(0);
    expect(healed.heals).toBeGreaterThan(0);
    expect(healed.survives).toBeGreaterThanOrEqual(bare.survives);
  });

  /* Todo 10, 2026-10-05: AutoHeal does not cast a chosen heal that mends less than the round; the run cast it. */
  it('casts a chosen heal only in a round it mends, as AutoHeal does', () => {
    const foes = [1, 2, 3].map((n) => ({
      name: `orc ${n}`,
      subject: { hp: 60, profiles: [biter(60, 6, 12)] }
    }));
    const run = (chosenMends: number | null): Survival =>
      simulateFight(
        fight({
          foes,
          casting: [null, null, null],
          mana: 200,
          manaMax: 200,
          heal: { below: 0.5, to: 0.8, restores: [1, 1], cost: 6, minMana: 0, chosenMends }
        })
      )!;
    expect(run(null).heals).toBeGreaterThan(0);
    expect(run(1000).heals).toBe(run(null).heals);
    expect(run(1).heals).toBe(0);
  });

  it('casts no heal past the mana floor, or with the mana unknown', () => {
    const foes = [{ name: 'orc', subject: { hp: 200, profiles: [biter(60, 8, 14)] } }];
    const heal = {
      below: 0.6,
      to: 0,
      restores: [20, 30] as [number, number],
      cost: 10,
      minMana: 0.9,
      chosenMends: null
    };
    const floored = simulateFight(fight({ foes, heal, mana: 20, manaMax: 40 }))!;
    expect(floored.heals).toBe(0);
    const unknown = simulateFight(fight({ foes, heal, mana: null, manaMax: null }))!;
    expect(unknown.heals).toBe(0);
  });

  it('refuses a foe the realm cannot weigh, and a fight it cannot win', () => {
    expect(simulateFight(fight({ foes: [{ name: 'stranger', subject: {} }] }))).toBeNull();
    // No arithmetic for the swing on this lineage and no spell: nothing to say.
    expect(simulateFight(fight({ family: 'majormud' }))).toBeNull();
    // A bare hand is still a fight (2026-10-01).
    expect(simulateFight(fight({ weapon: null }))).not.toBeNull();
    expect(simulateFight(fight({ foes: [] }))).toBeNull();
  });

  /*
   * 2026-10-05: a lair's monsters all swung from the first round, where the
   * server lets one that does not attack on sight in only once it is struck
   * (`Mob.ShouldMobAttackTarget`, `RecentAttackers`).
   */
  it('brings a monster that waits into the fight only when it is struck', () => {
    const three = (waits: boolean): SurvivalInput['foes'] =>
      [1, 2, 3].map((n) => ({
        name: `ogre ${n}`,
        subject: { hp: 60, profiles: [biter(80, 12, 22)] },
        waits
      }));
    const all = simulateFight(
      fight({ foes: three(false), casting: [null, null, null], horizons: [1] })
    )!;
    const one = simulateFight(
      fight({ foes: three(true), casting: [null, null, null], horizons: [1] })
    )!;
    expect(one.survives).toBeGreaterThan(all.survives);
    expect(one.horizons[0]!.lost.mean).toBeLessThan(all.horizons[0]!.lost.mean / 2);
  });

  // The drunken gambler's row names no attack: a fight against it is run, and costs nothing.
  it('runs a monster that states no attack as one that deals nothing', () => {
    const run = simulateFight(
      fight({ foes: [{ name: 'gambler', subject: { hp: 30, profiles: [] } }] })
    )!;
    expect(run.survives).toBe(1);
    expect(run.lostMean).toBe(0);
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

  /* 2026-10-02: one lair's fight held main 250 to 800ms in one piece; the odds book runs it in slices. */
  it('comes to the same run when its trials are run a few at a time', () => {
    const foes = [1, 2].map((n) => ({
      name: `orc ${n}`,
      subject: { hp: 80, profiles: [biter(70, 6, 12)] }
    }));
    const input = fight({ foes, casting: [null, null], draw: 2 });
    const pieces = startFight(input)!;
    let slices = 0;
    while (!pieces.done) {
      let left = 7;
      pieces.run(() => --left === 0);
      slices += 1;
    }
    expect(slices).toBeGreaterThan(1);
    expect(pieces.result()).toEqual(simulateFight(input));
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

  /*
   * The spell goes first, as `AttackSpells` casts the chosen spell before the
   * melee round, and the sword once the mana runs dry (todo 20): a Mage with
   * a quarterstaff and magic missile was priced swinging the staff.
   */
  it('casts while the mana pays, and swings once it runs dry', () => {
    const foes = [{ name: 'orc', subject: { hp: 200, profiles: [biter(20, 1, 3)] } }];
    const swung = simulateFight(fight({ foes, mana: 12, manaMax: 12 }))!;
    const cast = simulateFight(
      fight({ foes, mana: 12, manaMax: 12, casting: [{ perRound: 100, manaPerRound: 4 }] })
    )!;
    expect(cast.rounds.value).toBeLessThan(swung.rounds.value);
    expect(cast.manaMean).toBe(8);
    expect(swung.manaMean).toBe(0);
    const dry = simulateFight(
      fight({ foes, mana: 2, manaMax: 12, casting: [{ perRound: 100, manaPerRound: 4 }] })
    )!;
    expect(dry.rounds.value).toBe(swung.rounds.value);
  });

  it('charges a lapsing blessing’s recast against the heals', () => {
    const foes = [{ name: 'orc', subject: { hp: 300, profiles: [biter(60, 8, 14)] } }];
    const heal = {
      below: 0.6,
      to: 0.9,
      restores: [15, 20] as [number, number],
      cost: 10,
      minMana: 0,
      chosenMends: null
    };
    const kept = simulateFight(fight({ foes, heal, mana: 30, manaMax: 100 }))!;
    const spent = simulateFight(
      fight({
        foes,
        heal,
        mana: 30,
        manaMax: 100,
        recasts: [{ round: 1, cost: 25, minMana: 0, effect: null }]
      })
    )!;
    expect(spent.heals).toBeLessThan(kept.heals);
  });

  /* Todo 10, 2026-10-05: a recast was charged its mana and the blessing stayed up whether it was paid or not. */
  it('takes a lapsed blessing off the character when nobody recasts it', () => {
    const foes = [1, 2, 3].map((n) => ({
      name: `orc ${n}`,
      subject: { hp: 60, profiles: [biter(60, 6, 12)] }
    }));
    const shield = { ...NO_EFFECT, armourClass: 30 };
    const lapsing = (cost: number | null, mana: number | null = 40, minMana = 0): Survival =>
      simulateFight(
        fight({
          foes,
          casting: [null, null, null],
          mana,
          player: { armourClass: 50, damageResist: 1, magicRes: 0 },
          recasts: [{ round: 1, cost, minMana, effect: shield }]
        })
      )!;
    const recast = lapsing(5);
    const gone = lapsing(null);
    expect(gone.lostMean).toBeGreaterThan(recast.lostMean);
    // Unknown mana pays for nothing: the same fight as one nobody recasts.
    const unread = lapsing(5, null);
    expect(unread.lostMean).toBe(gone.lostMean);
    expect(unread.survives).toBe(gone.survives);
    // Under the row's mana floor it waits, so it is gone: 30 of 40 is under 0.9, 40 is not.
    expect(lapsing(5, 40, 0.9).lostMean).toBe(recast.lostMean);
    expect(lapsing(5, 30, 0.9).lostMean).toBe(gone.lostMean);
  });

  /* `Player.InitiateSpell` casts a blessing with `BreakCombat`: the swing goes with the cast. */
  it('spends the character’s turn on a recast it pays for', () => {
    const foes = [{ name: 'orc', subject: { hp: 60, profiles: [biter(20, 1, 3)] } }];
    const plain = simulateFight(fight({ foes }))!;
    const recast = simulateFight(
      fight({ foes, recasts: [{ round: 1, cost: 0, minMana: 0, effect: null }] })
    )!;
    expect(recast.rounds.value).toBeGreaterThan(plain.rounds.value);
  });

  it('lowers the top of the bar when a lapsed blessing raised it', () => {
    const run = simulateFight(
      fight({
        recasts: [{ round: 1, cost: null, minMana: 0, effect: { ...NO_EFFECT, maxHp: 30 } }]
      })
    )!;
    expect(run.hpLeft!).toBeLessThanOrEqual(70);
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

/*
 * Todo 03 (2026-09-27): Festus (Paladin 24, 306 hp, AC 63, DR 13, MR 47) was
 * told a room of skeletal acolytes was 100% survivable, and the acolyte's
 * spear of dark energy (spell 5103, cast at level 28: 36 to 89) took 84, 78
 * and 74 off him in three rounds. The spear was added as its average across
 * every round; it is rolled now, and three acolytes spearing together is the
 * round that kills. The rows are the realm's, from the GreaterMUD world file.
 */
describe('a monster whose blow is a spell', () => {
  const spells: Record<number, WorldSpell> = {
    5103: {
      id: 5103,
      name: 'spear of dark energy',
      targets: 8,
      abilities: [[17, 0]],
      power: [27, 61],
      minGrowth: [3, 1],
      maxGrowth: [2, 2]
    },
    17: {
      id: 17,
      name: 'major healing',
      targets: 2,
      abilities: [[18, 0]],
      power: [6, 10],
      cap: 30,
      minGrowth: [3, 1],
      maxGrowth: [1, 1]
    },
    66: { id: 66, name: 'hold person', duration: 4, targets: 8, resist: 2, abilities: [[74, 0]] }
  };
  const acolyte = {
    hp: 260,
    armourClass: 50,
    damageResist: 4,
    magicResist: 90,
    spells,
    profiles: [
      {
        attacks: [
          { kind: 'melee' as const, chance: 0.75, accuracy: 105, min: 11, max: 26, energy: 500 },
          {
            kind: 'spell' as const,
            chance: 0.25,
            spell: 5103,
            castChance: 1,
            level: 28,
            energy: 1000
          }
        ],
        casts: [
          { spell: 66, chance: 0.1, level: 25 },
          { spell: 17, chance: 0.1, level: 25 }
        ]
      }
    ]
  };
  const festus = (count: number): SurvivalInput =>
    fight({
      hp: 306,
      hpMax: 306,
      mana: 69,
      manaMax: 69,
      player: { armourClass: 63, damageResist: 13, magicRes: 47 },
      sheet: {
        ...SHEET,
        level: 24,
        agility: 80,
        intellect: 40,
        charm: 50,
        health: 70,
        strength: 112,
        spellcasting: 88,
        combatLevel: 3,
        mageryLevel: 2,
        encumbrancePercent: 63
      },
      weapon: { min: 10, max: 40, speed: 1400, strength: 60 },
      foes: Array.from({ length: count }, (_, n) => ({ name: `acolyte ${n}`, subject: acolyte })),
      casting: Array.from({ length: count }, () => null),
      heal: { below: 0.5, to: 0.8, restores: [14, 38], cost: 6, minMana: 0, chosenMends: null },
      levels: { safeAbove: 0.6, riskyAbove: 0.25 },
      horizons: [1, 3, 6, 12, 24]
    });

  it('lands a spear whole, so one round can take a third of the bar', () => {
    const one = simulateFight(festus(1))!;
    // One spear through MR 47 is at least 36 × 1.03; the worst round holds one and a blow.
    expect(one.worstRound).toBeGreaterThanOrEqual(70);
    expect(one.horizons[0]!.lost.most).toBeGreaterThanOrEqual(70);
  });

  it('reads a room of three as not survivable', () => {
    const three = simulateFight(festus(3))!;
    expect(three.level).toBe('deadly');
    expect(three.survives).toBeLessThanOrEqual(0.25);
    expect(three.worstRound).toBeGreaterThan(150);
  });

  it('reads the fight part way, the rounds in order', () => {
    const three = simulateFight(festus(3))!;
    expect(three.horizons.map((at) => at.rounds)).toEqual([1, 3, 6, 12, 24]);
    const standing = three.horizons.map((at) => at.standing);
    expect([...standing].sort((a, b) => b - a)).toEqual(standing);
    const lost = three.horizons.map((at) => at.lost.mean);
    expect([...lost].sort((a, b) => a - b)).toEqual(lost);
  });

  it('draws a lair’s spawns to its cap', () => {
    const pool = simulateFight({ ...festus(1), draw: 3 })!;
    const three = simulateFight(festus(3))!;
    expect(pool.survives).toBeLessThanOrEqual(0.25);
    expect(Math.abs(pool.survives - three.survives)).toBeLessThan(0.1);
  });
});
