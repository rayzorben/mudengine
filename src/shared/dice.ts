/**
 * The rolls a simulated fight is made of, on a seeded generator so the same
 * fight reads the same every time it is run (`survival.ts`, `mobRound.ts`).
 */

/** A source of fractions in `[0, 1)`. */
export type Random = () => number;

/** A whole number in `[low, high]`, either way round. */
export function between(random: Random, low: number, high: number): number {
  const a = Math.min(low, high);
  const b = Math.max(low, high);
  return a + Math.floor(random() * (b - a + 1));
}

/** A fractional expectation as a whole count: the floor, and one more with the fraction's chance. */
export function sampledCount(random: Random, expected: number): number {
  const whole = Math.floor(expected);
  return whole + (random() < expected - whole ? 1 : 0);
}

/** Mulberry32: a small, seedable generator, so a room reads the same every time it is weighed. */
export function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
