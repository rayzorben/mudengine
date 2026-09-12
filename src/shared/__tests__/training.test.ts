import { describe, expect, it } from 'vitest';

import { nextPointCost, planTraining, raiseCost, wantsMore } from '../training';

/*
 * Vaelor, a Nekojin (`Races`: mSTR 40 / xSTR 140, mAGL 60 / xAGL 170,
 * mHEA 30 / xHEA 120), driven live 2026-09-12: Health 71 was accepted for
 * 5 CP and Strength 95 refused with `You may not assign that much`.
 */
const LIMITS = {
  strength: { base: 40, max: 140 },
  intellect: { base: 40, max: 140 },
  willpower: { base: 30, max: 130 },
  agility: { base: 60, max: 170 },
  health: { base: 30, max: 120 },
  charm: { base: 50, max: 150 }
};
const CURRENT = { strength: 90, intellect: 80, willpower: 30, agility: 110, health: 70, charm: 70 };
const NOTHING = { strength: 0, intellect: 0, willpower: 0, agility: 0, health: 0, charm: 0 };

describe('what a point costs', () => {
  it("is StatField.Validate's loop: one more per ten above the race base", () => {
    expect(nextPointCost(40, 90)).toBe(6);
    expect(nextPointCost(60, 110)).toBe(6);
    expect(nextPointCost(30, 70)).toBe(5);
    // The first ten above the base are one each; the eleventh is two.
    expect(nextPointCost(40, 40)).toBe(1);
    expect(nextPointCost(40, 49)).toBe(1);
    expect(nextPointCost(40, 50)).toBe(2);
    expect(raiseCost(40, 90, 95)).toBe(30);
    expect(raiseCost(30, 70, 71)).toBe(5);
  });
});

describe('planning the spend', () => {
  it('buys the cheapest wanted point first, and stops where the next one is not affordable', () => {
    const plan = planTraining({
      current: CURRENT,
      wanted: { ...NOTHING, strength: 95, health: 75 },
      limits: LIMITS,
      cp: 10
    });
    // Health at 5 wins over Strength at 6; the second Health point leaves 0.
    expect(plan.purchases).toEqual([{ attribute: 'health', from: 70, to: 72, cost: 10 }]);
    expect(plan.spent).toBe(10);
    expect(plan.left).toBe(0);
    // Both are still wanted and neither's next point is affordable now, cheapest first.
    expect(plan.unaffordable).toEqual([
      { attribute: 'health', nextCost: 5 },
      { attribute: 'strength', nextCost: 6 }
    ]);
    expect(plan.targets.health).toBe(72);
    expect(plan.targets.strength).toBe(90);
  });

  it('buys nothing where every wanted figure is at or under the current one', () => {
    const plan = planTraining({
      current: CURRENT,
      wanted: { ...NOTHING, strength: 90, health: 60 },
      limits: LIMITS,
      cp: 10
    });
    expect(plan.purchases).toEqual([]);
    expect(plan.unaffordable).toEqual([]);
    expect(plan.left).toBe(10);
  });

  it("aims at the race's ceiling where a figure is wanted above it, and says so", () => {
    const plan = planTraining({
      current: { ...CURRENT, health: 119 },
      wanted: { ...NOTHING, health: 200 },
      limits: LIMITS,
      cp: 100
    });
    expect(plan.capped).toEqual(['health']);
    expect(plan.purchases).toEqual([{ attribute: 'health', from: 119, to: 120, cost: 9 }]);
  });

  it('breaks a tie in field order', () => {
    const plan = planTraining({
      current: CURRENT,
      wanted: { ...NOTHING, strength: 91, agility: 111 },
      limits: LIMITS,
      cp: 6
    });
    expect(plan.purchases).toEqual([{ attribute: 'strength', from: 90, to: 91, cost: 6 }]);
  });
});

describe("the reviewer's rule", () => {
  it('wants more only where a wanted figure is above a figure the sheet has', () => {
    expect(wantsMore({ ...NOTHING, strength: 90 }, CURRENT)).toBe(false);
    expect(wantsMore({ ...NOTHING, strength: 91 }, CURRENT)).toBe(true);
    // An unread figure is not a reason to open the screen.
    expect(wantsMore({ ...NOTHING, strength: 91 }, { ...CURRENT, strength: null })).toBe(false);
  });
});
