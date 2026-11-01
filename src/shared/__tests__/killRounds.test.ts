import { describe, expect, it } from 'vitest';

import { roundsToKill } from '../killRounds';

/*
 * 2026-11-01: Festus's horned spiders (660 health) took about 550 a round and
 * died on the second round, 2,100 kills in a row, while the Hunting card
 * priced a kill at 1.2 rounds and a lair of the same pay at 3.9M an hour.
 */
describe('rounds to kill', () => {
  it('is the next whole round where the round never varies', () => {
    expect(roundsToKill(660, 550, 0)).toBe(2);
    expect(roundsToKill(550, 550, 0)).toBe(1);
    expect(roundsToKill(100, 550, 0)).toBe(1);
  });

  it('stays on the second round for a horned spider at a tight spread', () => {
    // Not one of the 2,100 died on the first round: a spread of 50 a round or less.
    expect(roundsToKill(660, 550, 50 * 50)).toBeCloseTo(2, 1);
  });

  it('takes a round in about half the fights where the round is the health on average', () => {
    const rounds = roundsToKill(500, 500, 100 * 100);
    expect(rounds).toBeGreaterThan(1.4);
    expect(rounds).toBeLessThan(1.6);
  });

  it('comes to the plain ratio, half a round and the spread over a long fight', () => {
    // The renewal limit: health / mean + 1/2 + variance / (2 mean²).
    expect(roundsToKill(10_000, 100, 50 * 50)).toBeCloseTo(100.625, 1);
    expect(roundsToKill(1e9, 1, 1)).toBeCloseTo(1e9 + 0.5, 0);
  });

  it('never ends where nothing is dealt', () => {
    expect(roundsToKill(660, 0, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});
