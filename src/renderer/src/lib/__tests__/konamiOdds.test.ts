import { describe, expect, it } from 'vitest';

import { oddsShown } from '../konami';

/**
 * The card's odds list hides what the reply gave nothing (todo 67): a list of
 * eleven goals with nine at 0% buries the two that were weighed.
 */
describe('the odds the card draws', () => {
  const option = (p: number, chosen = false) => ({ p, chosen });

  it('folds away what the reply gave under a whole percent, and counts it', () => {
    const { shown, hidden } = oddsShown([
      option(0.98, true),
      option(0.01),
      option(0.004),
      option(0)
    ]);
    expect(shown.map((row) => row.p)).toEqual([0.98, 0.01]);
    expect(hidden).toBe(2);
  });

  it('keeps the chosen one whatever it was given', () => {
    const { shown, hidden } = oddsShown([option(0.002, true), option(0.003)]);
    expect(shown).toEqual([option(0.002, true)]);
    expect(hidden).toBe(1);
  });
});
