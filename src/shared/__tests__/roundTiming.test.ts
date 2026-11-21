import { describe, expect, it } from 'vitest';

import { blessGoesNow, offRoundMs, stepGoesNow } from '../roundTiming';

/* Paradigm on paramud: a round every 5,000 ms; a step 1,239 ms unladen, 1,854 ms with loot. */
const MARGIN = 500;

describe('the off-round after each round', () => {
  it('is the stretch in which a step still goes', () => {
    for (const step of [1239, 1854]) {
      const off = offRoundMs(5000, step, MARGIN);
      expect(stepGoesNow(5000 - (off - 1), 5000, step, MARGIN)).toBe(true);
      expect(stepGoesNow(5000 - (off + 1), 5000, step, MARGIN)).toBe(false);
    }
  });

  it('is 2.02 s unladen and 0.79 s laden', () => {
    expect(offRoundMs(5000, 1239, MARGIN)).toBe(2022);
    expect(offRoundMs(5000, 1854, MARGIN)).toBe(792);
  });

  it('is the margin alone where two steps never fit, as on orohost', () => {
    expect(offRoundMs(1000, 1239, MARGIN)).toBe(MARGIN);
  });

  it('is never longer than the round', () => {
    expect(offRoundMs(400, 1239, MARGIN)).toBe(400);
  });
});

/* Cretin on Paradigm, 2026-11-21: a round every 5 s; half of it is the off-round for a blessing. */
describe('a blessing cast in a fight', () => {
  it('goes in the first half of the round after its blows', () => {
    expect(blessGoesNow(40, 4960, 5000, 0.5)).toBe(true);
    expect(blessGoesNow(2500, 2500, 5000, 0.5)).toBe(true);
  });

  it('waits for the next round once the half is past, as 1.0 s before the round', () => {
    expect(blessGoesNow(2501, 2499, 5000, 0.5)).toBe(false);
    expect(blessGoesNow(4051, 1005, 5000, 0.5)).toBe(false);
  });

  it('goes by the beat where a round came due and none was seen', () => {
    expect(blessGoesNow(7400, 2600, 5000, 0.5)).toBe(false);
    expect(blessGoesNow(10_100, 4900, 5000, 0.5)).toBe(true);
    expect(blessGoesNow(14_000, 1000, 5000, 0.5)).toBe(false);
  });

  it('is half a second on orohost, a round a second', () => {
    expect(blessGoesNow(500, 500, 1000, 0.5)).toBe(true);
    expect(blessGoesNow(600, 400, 1000, 0.5)).toBe(false);
  });
});
