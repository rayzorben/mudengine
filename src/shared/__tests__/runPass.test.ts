import { describe, expect, it } from 'vitest';

import { caughtChance, runDeath, sneakHolds, type RunLair } from '../runPass';

const lair = (caught: number, kills: number | null): RunLair => ({
  room: '17/4',
  name: 'Dirt Path',
  caught,
  kills
});

describe('a run past lairs', () => {
  it('is caught for the share of a round the move takes', () => {
    // GreaterMUD's unencumbered step against a five-second round.
    expect(caughtChance(1100, 5000)).toBeCloseTo(0.22);
    expect(caughtChance(3100, 5000)).toBeCloseTo(0.62);
    expect(caughtChance(9000, 5000)).toBe(1);
  });

  it('sneaks past on Stealth less the room left, uncapped at 95', () => {
    expect(sneakHolds(80, 3)).toBeCloseTo(0.77);
    expect(sneakHolds(130, 0)).toBe(1);
    expect(sneakHolds(2, 5)).toBe(0);
    expect(sneakHolds(null, 0)).toBe(0);
  });

  it('dies where any lair catches and kills', () => {
    expect(runDeath([])).toBe(0);
    expect(runDeath([lair(0.22, 0)])).toBe(0);
    expect(runDeath([lair(0.5, 0.1), lair(0.5, 0.1)])).toBeCloseTo(1 - 0.95 * 0.95);
  });

  it('is unknown while a lair that can catch has no figure, and not while one cannot', () => {
    expect(runDeath([lair(0.22, null)])).toBeNull();
    expect(runDeath([lair(0, null)])).toBe(0);
  });
});
