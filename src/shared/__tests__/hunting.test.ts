import { describe, expect, it } from 'vitest';

import {
  compareSpots,
  estimateSpot,
  respawnSeconds,
  type HuntingConstants,
  type HuntingSpot,
  type SpotInput
} from '../hunting';
import { DEFAULT_INTERNAL } from '../internal';

const C: HuntingConstants = DEFAULT_INTERNAL.tuning.hunting;

/*
 * `Room.GetDelayInSeconds`: minutes, except an Arena room and a negative
 * figure are seconds. Then GreaterMUD's regen adds thirty seconds to the
 * elapsed time before comparing (`RegenSlot.cs:33`), so its lairs come back
 * sooner than the column says — measured 18–20s in a `Delay=1` lair.
 */
describe('the respawn clock', () => {
  it('reads minutes on MajorMUD, and thirty seconds sooner on GreaterMUD', () => {
    expect(respawnSeconds(2, 'majormud', C)).toBe(120);
    expect(respawnSeconds(2, 'greatermud', C)).toBe(90);
    expect(respawnSeconds(1, 'greatermud', C)).toBe(30);
  });

  it('reads a negative figure and an arena as seconds', () => {
    expect(respawnSeconds(-45, 'majormud', C)).toBe(45);
    expect(respawnSeconds(45, 'majormud', C, true)).toBe(45);
    expect(respawnSeconds(-10, 'greatermud', C)).toBe(0);
  });

  it('states no clock for a room that states none', () => {
    expect(respawnSeconds(null, 'greatermud', C)).toBeNull();
    expect(respawnSeconds(0, 'greatermud', C)).toBeNull();
  });
});

const singles = (over: Partial<SpotInput> = {}): SpotInput => ({
  rooms: 1,
  spawns: 1,
  mobs: [{ name: 'mutant', experience: 225, rounds: 6, perRound: 10 }],
  respawnSeconds: 30,
  loopSteps: 0,
  character: {
    hpMax: 289,
    restingHealthPerTick: 24,
    passiveHealthPerTick: 8,
    backstab: false
  },
  ...over
});

describe('what a spot pays', () => {
  it('folds a kill, its rest and the wait for the respawn into one cycle', () => {
    const e = estimateSpot(singles(), C);
    // Six rounds of five seconds and the kill's overhead.
    expect(e.combatSeconds).toBeCloseTo(6 * 5 + 1.5, 5);
    // Sixty hit points taken, a little regained standing, three resting ticks.
    expect(e.damagePerRoom).toBe(60);
    expect(e.restSeconds).toBe(45);
    // Slower than the clock, so no waiting; the rate is the cycle's.
    expect(e.waitSeconds).toBe(0);
    expect(e.cycleSeconds).toBeCloseTo(31.5 + 45, 5);
    expect(e.expPerHour).toBeCloseTo((225 * 3600) / 76.5, 3);
    expect(e.ceilingPerHour).toBeCloseTo((225 * 3600) / 30, 3);
    expect(e.deadly).toBe(false);
    expect(e.unknown).toEqual([]);
  });

  /* The reviewer's point: a backstabber wants singles, and the arithmetic says why. */
  it('credits the opener on every kill in a room of singles, once a pack', () => {
    const alone = estimateSpot(
      singles({ character: { ...singles().character, backstab: true } }),
      C
    );
    // Six rounds becomes one opener round and two more.
    expect(alone.roundsPerKill).toBe(3);
    const pack = estimateSpot(
      singles({ spawns: 3, character: { ...singles().character, backstab: true } }),
      C
    );
    // The first of three is opened; the other two are plain.
    expect(pack.roundsPerKill).toBeCloseTo((3 + 6 + 6) / 3, 5);
  });

  it('prices a pack ramping down: the rest keep swinging while the first dies', () => {
    const pack = estimateSpot(singles({ spawns: 3 }), C);
    // 10 hp a round × 6 rounds × (3 + 2 + 1) monsters still up.
    expect(pack.damagePerRoom).toBe(10 * 6 * 6);
    expect(pack.expPerCycle).toBe(225 * 3);
  });

  it('waits for the clock when the cycle is faster than the respawn', () => {
    const e = estimateSpot(singles({ respawnSeconds: 300 }), C);
    expect(e.waitSeconds).toBeCloseTo(300 - 76.5, 5);
    expect(e.expPerHour).toBeCloseTo((225 * 3600) / 300, 3);
  });

  it('names what it could not finish, and never zeroes it', () => {
    const e = estimateSpot(
      singles({
        respawnSeconds: null,
        character: { ...singles().character, restingHealthPerTick: null, hpMax: null }
      }),
      C
    );
    expect(e.expPerHour).toBeNull();
    expect(e.ceilingPerHour).toBeNull();
    expect(e.unknown).toEqual(['respawn', 'health', 'rest']);
    // What it could work out, it did.
    expect(e.combatSeconds).toBeCloseTo(31.5, 5);
    expect(e.damagePerRoom).toBe(60);
  });

  it('calls a room that takes the whole bar deadly, and rates it nothing', () => {
    const e = estimateSpot(
      singles({ mobs: [{ name: 'dragon', experience: 50_000, rounds: 20, perRound: 30 }] }),
      C
    );
    expect(e.damagePerRoom).toBe(600);
    expect(e.deadly).toBe(true);
    expect(e.expPerHour).toBeNull();
    expect(e.ceilingPerHour).not.toBeNull();
  });

  it('spreads a loop over its rooms and walks between them', () => {
    const e = estimateSpot(singles({ rooms: 4, loopSteps: 12 }), C);
    expect(e.walkSeconds).toBeCloseTo(12 * 1.25, 5);
    expect(e.expPerCycle).toBe(225 * 4);
    expect(e.combatSeconds).toBeCloseTo(4 * 31.5, 5);
  });
});

describe('the order the reader wants', () => {
  const spot = (
    key: string,
    rate: number | null,
    ceiling: number | null,
    deadly = false
  ): HuntingSpot => ({
    key,
    mobs: [],
    clock: 'delay',
    respawnSeconds: 30,
    spawns: 1,
    rooms: [{ id: '1/1', map: 1, room: 1, name: 'Here', steps: 3 }],
    roomCount: 1,
    loopSteps: 0,
    estimate: {
      expPerHour: rate,
      ceilingPerHour: ceiling,
      expPerCycle: null,
      cycleSeconds: null,
      combatSeconds: null,
      restSeconds: null,
      walkSeconds: 0,
      waitSeconds: null,
      damagePerRoom: null,
      damageShare: null,
      roundsPerKill: null,
      deadly,
      unknown: []
    }
  });

  it('puts a known rate first, an unknown one by its ceiling after, and deadly last', () => {
    const ordered = [
      spot('deadly-rich', null, 9_000_000, true),
      spot('unknown-high', null, 500_000),
      spot('known-low', 20_000, 50_000),
      spot('known-high', 100_000, 200_000),
      spot('unknown-low', null, 40_000)
    ].sort(compareSpots);
    expect(ordered.map((s) => s.key)).toEqual([
      'known-high',
      'known-low',
      'unknown-high',
      'unknown-low',
      'deadly-rich'
    ]);
  });
});
