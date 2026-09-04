import { describe, expect, it } from 'vitest';

import { meterValue } from '../vitals';

/*
 * The number beside a party member's bar. The percentage is the listing's and
 * is refreshed by every listing; the maximum is from an `@health` answer and
 * is the half of that answer that stays true. The absolute figure is
 * deliberately not printed beside a percentage it may no longer agree with.
 */
describe('the number beside a party bar', () => {
  it('is a dash when the listing has not said, whatever else is known', () => {
    expect(meterValue(null, null)).toBe('—');
    expect(meterValue(null, 4434)).toBe('—');
  });

  it('is the percentage alone until somebody has answered @health', () => {
    expect(meterValue(0.4, null)).toBe('40%');
    expect(meterValue(1, null)).toBe('100%');
  });

  /* 30% of 4,434 and 30% of 62 are the same bar and different emergencies. */
  it('says what the percentage is of, once the maximum is known', () => {
    expect(meterValue(0.3, 4434)).toBe(`30% of ${(4434).toLocaleString()}`);
    expect(meterValue(0.3, 62)).toBe('30% of 62');
  });

  /* Like the purse and the experience: a thousands separator, so one card does
     not print `4434` where the next prints `2,199,807`. Asserted through the
     same call the code makes, because the separator is the locale's. */
  it('separates thousands the way the rest of the chrome does', () => {
    expect(meterValue(0.5, 12000)).toBe(`50% of ${(12000).toLocaleString()}`);
  });

  it('rounds the way the bar did before', () => {
    expect(meterValue(0.625, 80)).toBe('63% of 80');
  });
});
