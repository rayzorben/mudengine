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

  /* 2026-10-06: a caster's fights of a round or two took eleven minutes to read 5 on orohost. */
  it('starts from the figure kept from the last connection, and keeps each new one', () => {
    let kept: number | null = 5;
    const remembered: number[] = [];
    const speed = new RealmSpeed();
    speed.useKept({ recall: () => kept, remember: (each) => void remembered.push(each) });
    expect(speed.multiplier).toBe(5);
    fight(speed, 0, tuning().hunting.speedRounds + 1, 5000);
    expect(speed.multiplier).toBe(1);
    expect(remembered).toEqual([1]);
    kept = 1;
    speed.reset();
    expect(speed.multiplier).toBe(1);
  });

  /* 2026-10-06, orohost: a Mage's slimes left no rounds to read in 25 minutes; the standing tick came every 5.8 to 6.1 s. */
  it('reads the realm’s speed off the standing tick out of a fight', () => {
    const { speedRounds } = tuning().hunting;
    const speed = new RealmSpeed();
    let hp = 40;
    let at = 0;
    // The first line is the health it starts from, the first rise the tick the gaps run from.
    for (let tick = 0; tick <= speedRounds + 1; tick += 1) {
      // The standing tick, every second rest tick: 30 s on the server, 6 s at speed 5, give or take.
      at += tick % 2 === 0 ? 6020 : 5920;
      hp += 1;
      speed.healthRose(hp, false, false, at);
    }
    expect(speed.multiplier).toBe(5);
  });

  /* Review, 2026-10-06: the standing gain comes on every second rest tick, so counted by the rest tick a speed of 4 read 2. */
  it('reads an even speed off standing rises, and the rest tick off resting ones', () => {
    const { speedRounds } = tuning().hunting;
    const standing = new RealmSpeed();
    for (let tick = 0; tick <= speedRounds + 1; tick += 1)
      standing.healthRose(40 + tick, false, false, tick * 7520);
    expect(standing.multiplier).toBe(4);
    const resting = new RealmSpeed();
    for (let tick = 0; tick <= speedRounds + 1; tick += 1)
      resting.healthRose(40 + tick * 3, true, false, tick * 3010);
    expect(resting.multiplier).toBe(5);
  });

  it('counts no rise in a fight, nor a gap past the longest, nor a fall', () => {
    const speed = new RealmSpeed();
    speed.healthRose(40, false, false, 0);
    speed.healthRose(41, false, false, 1000); // the tick the next gap runs from
    speed.healthRose(42, false, true, 3000); // a heal mid-fight is off the tick
    speed.healthRose(30, false, false, 4000); // a blow: health fell
    speed.healthRose(31, false, false, 60_000); // 59 s on: past the longest gap counted
    for (let tick = 1; tick < tuning().hunting.speedRounds; tick += 1)
      speed.healthRose(31 + tick, false, false, 60_000 + tick * 6000);
    // One short of a reading: the rise mid-fight and the long gap were not counted.
    expect(speed.multiplier).toBe(1);
    speed.healthRose(50, false, false, 60_000 + tuning().hunting.speedRounds * 6000);
    expect(speed.multiplier).toBe(5);
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
