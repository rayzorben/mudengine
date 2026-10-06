import { describe, expect, it } from 'vitest';

import { RealmSpeed, speedOf } from '../RealmSpeed';
import { tuning } from '../../app/tuning';

/** A fight's blows: each round's two blows `within` ms apart, rounds `every` ms apart. */
function fight(
  speed: RealmSpeed,
  start: number,
  rounds: number,
  every: number,
  within = 120
): number {
  for (let round = 0; round < rounds; round += 1) {
    const at = start + round * every;
    speed.onBlock({ type: 'user-hits', at });
    speed.onBlock({ type: 'mob-misses', at: at + within });
  }
  return start + rounds * every;
}

const FIT = { least: 3, slack: 0.15, share: 0.8, fastest: 10 };

describe('the realm’s speed', () => {
  it('is the server’s round over the realm’s, a whole number', () => {
    expect(speedOf([1000, 1010, 990], 5000, FIT)).toBe(5);
    expect(speedOf([5000, 4990], 5000, { ...FIT, least: 2 })).toBe(1);
    expect(speedOf([1000], 5000, FIT)).toBeNull();
  });

  /* 2026-10-06, run 12: orc rogues on orohost, where the median read 2. */
  it('is the round that divides the gaps, where rounds go by with no blow', () => {
    const gaps = [2968, 2999, 1005, 995, 1947, 3020, 990, 2993, 1988, 3003, 1009, 2991];
    expect(speedOf(gaps, 5000, FIT)).toBe(5);
    // Every other round struck in: still the realm's round, not twice it.
    expect(speedOf([2000, 2010, 1990, 4000, 2000], 5000, FIT)).toBe(5);
  });

  it('reads past a stray gap, and nothing where too few fit', () => {
    expect(speedOf([1000, 1000, 1000, 1000, 1430], 5000, FIT)).toBe(5);
    expect(speedOf([1000, 1300, 1300, 1000, 1300], 5000, FIT)).toBeNull();
  });

  /* Review, 2026-10-06: with a quarter of the gaps stray, speed 10 explains more than 5 and passed first. */
  it('is not a multiple of the realm’s speed that explains only stray gaps besides', () => {
    // Nine whole rounds and three strays, one of which falls on a half round by chance.
    const gaps = [1000, 2000, 1000, 3000, 1000, 2000, 1000, 1000, 2000, 1500, 1270, 2730];
    expect(speedOf(gaps, 5000, FIT)).toBe(5);
  });

  it('keeps the figure read through a stretch that fits no speed, and counts no gap across a room', () => {
    const { speedRounds } = tuning().hunting;
    const speed = new RealmSpeed();
    let at = fight(speed, 0, speedRounds + 1, 1000);
    expect(speed.multiplier).toBe(5);
    // Stray gaps alone, more than are kept: no speed explains more than three in five of them.
    const strays = [1130, 1370, 2290, 2610, 3170];
    for (let each = 0; each < tuning().hunting.speedKept + 10; each += 1) {
      at += strays[each % strays.length]!;
      speed.onBlock({ type: 'user-hits', at });
    }
    expect(speed.multiplier).toBe(5);
    const moved = new RealmSpeed();
    at = 0;
    // A step between every round: each round opens in another room, so nothing is counted.
    for (let each = 0; each <= speedRounds; each += 1) {
      at += 1300;
      moved.onBlock({ type: 'room-name', at: at - 200 });
      moved.onBlock({ type: 'user-hits', at });
    }
    expect(moved.multiplier).toBe(1);
  });

  /* orohost: a round every second; paramud: every five. */
  it('counts only the gaps inside a fight', () => {
    const { speedRounds } = tuning().hunting;
    const fast = new RealmSpeed();
    // Fights of six rounds, half a minute of walking between them: five gaps a fight.
    let at = 0;
    for (let each = 0; each < Math.ceil(speedRounds / 5); each += 1)
      at = fight(fast, at + 30_000, 6, 1000);
    expect(fast.multiplier).toBe(5);
    const slow = new RealmSpeed();
    fight(slow, 0, speedRounds + 1, 5000);
    expect(slow.multiplier).toBe(1);
  });

  it('is the server’s own until enough rounds are seen, and again after a reset', () => {
    const speed = new RealmSpeed();
    fight(speed, 0, 3, 1000);
    expect(speed.multiplier).toBe(1);
    fight(speed, 10_000, tuning().hunting.speedRounds + 1, 1000);
    expect(speed.multiplier).toBe(5);
    speed.reset();
    expect(speed.multiplier).toBe(1);
  });
});
