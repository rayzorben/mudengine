import { describe, expect, it } from 'vitest';

import { hangUpCost, openingRefusal, roundsCouldKill } from '../danger';
import type { Survival } from '../survival';

const fight = (survives: number, worstRound: number): Survival =>
  ({ survives, worstRound }) as unknown as Survival;

const TUNE = { openAbove: 0.95, runRounds: 2 };

describe('the danger a fight is', () => {
  it('runs once the next worst rounds could take what is left', () => {
    // Two thugs that can land 22 in a round: 28 of 34 is already a run.
    expect(roundsCouldKill(28, fight(0.7, 22), 2)).toBe(true);
    expect(roundsCouldKill(28, fight(1, 11), 2)).toBe(false);
    expect(roundsCouldKill(22, fight(1, 11), 2)).toBe(true);
    expect(roundsCouldKill(28, null, 2)).toBe(false);
    expect(roundsCouldKill(5, fight(1, 11), 0)).toBe(false);
  });

  it('says when the next round alone could kill', () => {
    expect(roundsCouldKill(10, fight(0.5, 11), 1)).toBe(true);
    expect(roundsCouldKill(12, fight(0.5, 11), 1)).toBe(false);
    expect(roundsCouldKill(1, fight(0.5, 11), 0)).toBe(false);
  });

  it('opens only a fight survived well enough, leaving an unknown one to the run', () => {
    expect(openingRefusal(fight(1, 11), 34, 34, TUNE)).toBeNull();
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
    // Opened at 20, the next two worst rounds (22) could kill: rest to 23 first.
    expect(openingRefusal(fight(1, 11), 20, 34, TUNE)).toEqual({ kind: 'health', needs: 23 });
    // What two worst rounds want is more than the character has: rest to full.
    expect(openingRefusal(fight(1, 22), 30, 34, TUNE)).toEqual({ kind: 'health', needs: 34 });
    expect(openingRefusal(fight(0.1, 22), 5, 34, { openAbove: 0, runRounds: 0 })).toBeNull();
  });

  it('charges a hangup as a share of maximum health, and says when nobody stated it', () => {
    expect(hangUpCost(34, 25)).toBe(9);
    expect(hangUpCost(34, 0)).toBe(0);
    expect(hangUpCost(34, null)).toBeNull();
    expect(hangUpCost(null, 25)).toBe(0);
  });
});
