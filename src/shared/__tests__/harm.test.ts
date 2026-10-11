import { describe, expect, it } from 'vitest';

import { foldHarm, harmChecks, harmRounds, type HarmFold, type HarmRecord } from '../harm';
import { expectedHarm, mobTerms, type MobModel } from '../mobRound';

/*
 * The terms the model is made of (todo 26), and a fight's lines folded
 * against them. Figures are worked by hand from the slots.
 */
const model: MobModel = {
  slots: [{ kind: 'melee', chance: 1, energy: 500, lands: 0.5, min: 4, max: 8, onHit: null }],
  casts: [],
  resist: 1
};

const record = (over: Partial<HarmRecord>): HarmRecord => ({
  at: 0,
  mob: 'cave bear',
  ended: 'off',
  firstAt: 0,
  lastAt: 0,
  misses: 0,
  hits: 0,
  meleeDamage: 0,
  casts: 0,
  spellDamage: 0,
  joined: false,
  level: 5,
  hp: 50,
  hpMax: 50,
  armourClass: 10,
  damageResist: 1,
  magicRes: 50,
  gear: [],
  predicted: {
    row: 'cave bear',
    terms: mobTerms(model),
    odds: { kind: 'pending' },
    roundMs: 5_000
  },
  ...over
});

describe("the model's terms", () => {
  it('splits a round into swings, the landing share and a landed blow', () => {
    const terms = mobTerms(model);
    // 1,000 energy a round over 500 a swing.
    expect(terms.swings).toBe(2);
    expect(terms.lands).toBe(0.5);
    // (4 + 8) / 2 less the 1 resisted.
    expect(terms.perHit).toBe(5);
    expect(terms.casts).toBe(0);
    expect(terms.perCast).toBeNull();
    expect(terms.harm).toBeCloseTo(expectedHarm(model));
    expect(terms.swings * terms.lands! * terms.perHit!).toBeCloseTo(terms.harm);
  });
});

describe('a fold of fights against the prediction', () => {
  it('reads a fight of k rounds as k − 1 round lengths', () => {
    expect(harmRounds({ firstAt: 0, lastAt: 10_000 }, 5_000)).toBe(3);
  });

  it('flags a landing share far above the predicted one', () => {
    const folds = new Map<string, HarmFold>();
    // Ten fights of three rounds: six swings predicted each, all six landed.
    for (let i = 0; i < 10; i += 1) {
      foldHarm(folds, record({ lastAt: 10_000, hits: 6, meleeDamage: 30 }), 5_000);
    }
    const checks = harmChecks(folds.get('cave bear')!);
    const lands = checks.find((check) => check.term === 'lands')!;
    expect(lands.seen).toBe(1);
    expect(lands.predicted).toBe(0.5);
    expect(lands.z).toBeGreaterThan(3);
    const swings = checks.find((check) => check.term === 'swings')!;
    expect(swings.z).toBeCloseTo(0);
    expect(checks.find((check) => check.term === 'perHit')).toMatchObject({ seen: 5, z: null });
  });

  it('reads each fight at the round its record stamped unless one is asked', () => {
    const folds = new Map<string, HarmFold>();
    const fast = record({
      lastAt: 10_000,
      predicted: { ...record({}).predicted!, roundMs: 1_000 }
    });
    foldHarm(folds, fast);
    expect(folds.get('cave bear')?.rounds).toBe(11);
    foldHarm(folds, fast, 5_000);
    expect(folds.get('cave bear')?.rounds).toBe(14);
  });

  it('counts a fight with no prediction and compares nothing from it', () => {
    const folds = new Map<string, HarmFold>();
    foldHarm(folds, record({ mob: 'odd thing', predicted: null, hits: 3 }), 5_000);
    expect(folds.get('odd thing')).toMatchObject({ fights: 1, hits: 0, rounds: 0 });
    expect(harmChecks(folds.get('odd thing')!)).toEqual([]);
  });
});
