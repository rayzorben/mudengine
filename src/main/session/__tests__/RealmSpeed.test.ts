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

describe('the realm’s speed', () => {
  it('is the server’s round over the realm’s, a whole number', () => {
    expect(speedOf([1000, 1010, 990], 5000, 3)).toBe(5);
    expect(speedOf([5000, 4990], 5000, 2)).toBe(1);
    expect(speedOf([1000], 5000, 3)).toBeNull();
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
