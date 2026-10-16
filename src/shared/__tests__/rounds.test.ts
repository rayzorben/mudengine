import { describe, expect, it } from 'vitest';
import { measuredFrom, swingKey, type RoundTally } from '../rounds';

const tallies = (casts: Array<[string, RoundTally]>, swings: Array<[string, RoundTally]> = []) => ({
  casts: new Map(casts),
  swings: new Map(swings)
});

describe('what a realm measured a round at', () => {
  it('is the mean of each tally past the least rounds', () => {
    // 30 rounds of one cast and 2 of two.
    const measured = measuredFrom(tallies([['harm', { rounds: 32, count: 34 }]]), 30);
    expect(measured?.casts['harm']).toBeCloseTo(1.0625, 6);
  });

  it('leaves out a tally under the least rounds, and is null with none past it', () => {
    expect(measuredFrom(tallies([['harm', { rounds: 29, count: 29 }]]), 30)).toBeNull();
    const measured = measuredFrom(
      tallies([['harm', { rounds: 29, count: 29 }]], [['bash@3.402', { rounds: 40, count: 122 }]]),
      30
    );
    expect(measured).toEqual({ casts: {}, swings: { 'bash@3.402': 3.05 } });
  });

  it('keys a swing by the attack and the figure the sheet stated, to three places', () => {
    expect(swingKey('bash', 3.402)).toBe('bash@3.402');
    expect(swingKey('attack', 2)).toBe('attack@2.000');
  });
});
