import { describe, expect, it } from 'vitest';

import {
  caughtChance,
  followRooms,
  runDeath,
  runRounds,
  sneakHolds,
  standingAfter,
  ticksIn,
  type RunLair
} from '../runPass';
import type { SurvivalHorizon } from '../survival';

const lair = (rounds: number, death: number | null): RunLair => ({
  room: '17/4',
  name: 'Dirt Path',
  rounds,
  death
});

const horizon = (rounds: number, standing: number): SurvivalHorizon => ({
  rounds,
  standing,
  won: 0,
  lost: { least: 0, mean: 0, most: 0 }
});

describe('a run past lairs', () => {
  it('is caught for the share of a round the move takes', () => {
    // GreaterMUD's unencumbered step against a five-second round.
    expect(caughtChance(1100, 5000)).toBeCloseTo(0.22);
    expect(caughtChance(3100, 5000)).toBeCloseTo(0.62);
    expect(caughtChance(9000, 5000)).toBe(1);
    // A one-second round ticks more than once in a step.
    expect(ticksIn(1100, 1000)).toBeCloseTo(1.1);
  });

  it('sneaks past on Stealth less the room left, uncapped at 95', () => {
    expect(sneakHolds(80, 3)).toBeCloseTo(0.77);
    expect(sneakHolds(130, 0)).toBe(1);
    expect(sneakHolds(2, 5)).toBe(0);
    expect(sneakHolds(null, 0)).toBe(0);
  });

  it('keeps a follower a move at its rate squared, and an unread one every move', () => {
    expect(followRooms(0, 6)).toBe(0);
    expect(followRooms(100, 6)).toBe(6);
    expect(followRooms(null, 6)).toBe(6);
    // 70% stays 49% of moves: 0.49 + 0.24 + 0.12 …
    expect(followRooms(70, 3)).toBeCloseTo(0.49 + 0.49 ** 2 + 0.49 ** 3);
  });

  it('takes the banked first round when caught, every further tick, and the follower’s', () => {
    expect(runRounds({ ticks: 0.22, firstRounds: 2, followRooms: 0 })).toBeCloseTo(0.44);
    expect(runRounds({ ticks: 0.22, firstRounds: 2, followRooms: 6 })).toBeCloseTo(1.76);
    expect(runRounds({ ticks: 1.1, firstRounds: 1, followRooms: 0 })).toBeCloseTo(1.1);
  });

  it('reads the fight’s standing between its horizons, from everyone standing', () => {
    const fight = [horizon(1, 0.9), horizon(3, 0.5)];
    expect(standingAfter(fight, 0)).toBe(1);
    expect(standingAfter(fight, 0.5)).toBeCloseTo(0.95);
    expect(standingAfter(fight, 2)).toBeCloseTo(0.7);
    expect(standingAfter(fight, 10)).toBeCloseTo(0.5);
  });

  it('dies where any lair kills', () => {
    expect(runDeath([])).toBe(0);
    expect(runDeath([lair(0.44, 0)])).toBe(0);
    expect(runDeath([lair(1, 0.05), lair(1, 0.05)])).toBeCloseTo(1 - 0.95 * 0.95);
  });

  it('is unknown while a lair that gets a round in has no figure, and not while one does not', () => {
    expect(runDeath([lair(0.44, null)])).toBeNull();
    expect(runDeath([lair(0, null)])).toBe(0);
  });
});
