import { describe, expect, it } from 'vitest';

import { deathRisk, hangUpCost, openingRefusal, roundsCouldKill, runDue } from '../danger';
import type { Survival } from '../survival';

/** A fight survived `survives` of the time, still standing `standing` of the time at round 3. */
const fight = (survives: number, worstRound: number, standing = 1): Survival =>
  ({
    survives,
    worstRound,
    horizons: [
      { rounds: 1, standing: 1, won: 0, lost: { least: 0, mean: 0, most: 0 } },
      { rounds: 3, standing, won: 0, lost: { least: 0, mean: 0, most: 0 } }
    ]
  }) as unknown as Survival;

const TUNE = { openAbove: 0.95, runRounds: 3, runRisk: 0.05 };

describe('the danger a fight is', () => {
  it('runs once the fight kills too often within the next rounds, not on the worst round doubled', () => {
    // A cave bear whose worst blow is 18, at 34 HP and full health: no run.
    expect(runDue(fight(0.99, 18, 0.999), TUNE)).toBeNull();
    // Two thugs at 28 HP: dead within three rounds a third of the time.
    expect(runDue(fight(0.5, 22, 0.66), TUNE)).toBeCloseTo(0.34);
    expect(runDue(null, TUNE)).toBeNull();
    expect(runDue(fight(0.5, 22, 0.66), { ...TUNE, runRisk: 0 })).toBeNull();
    expect(deathRisk(fight(0.5, 22, 0.66), 2)).toBeCloseTo(0.34);
  });

  it('says when the next round alone could kill', () => {
    expect(roundsCouldKill(10, fight(0.5, 11), 1)).toBe(true);
    expect(roundsCouldKill(12, fight(0.5, 11), 1)).toBe(false);
    expect(roundsCouldKill(1, fight(0.5, 11), 0)).toBe(false);
  });

  it('opens only a fight survived well enough, leaving an unknown one to the run', () => {
    expect(openingRefusal(fight(0.99, 18, 0.999), 34, 34, TUNE)).toBeNull();
    expect(openingRefusal(null, 34, 34, TUNE)).toBeNull();
    // At full health resting changes nothing; below it, rest to full first.
    expect(openingRefusal(fight(0.8, 5), 34, 34, TUNE)).toEqual({
      kind: 'odds',
      survives: 0.8,
      needs: null
    });
    expect(openingRefusal(fight(0.8, 5), 30, 34, TUNE)).toEqual({
      kind: 'odds',
      survives: 0.8,
      needs: 34
    });
    expect(openingRefusal(fight(0.75, 11, 0.8), 20, 34, TUNE)).toMatchObject({
      kind: 'risk',
      needs: 34
    });
    expect(
      openingRefusal(fight(0.1, 22, 0.1), 5, 34, { openAbove: 0, runRounds: 3, runRisk: 0 })
    ).toBeNull();
  });

  it('charges a hangup as a share of maximum health, and says when nobody stated it', () => {
    expect(hangUpCost(34, 25)).toBe(9);
    expect(hangUpCost(34, 0)).toBe(0);
    expect(hangUpCost(34, null)).toBeNull();
    expect(hangUpCost(null, 25)).toBe(0);
  });
});
