import { describe, expect, it } from 'vitest';

import { offRoundMs, stepGoesNow } from '../roundTiming';

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
