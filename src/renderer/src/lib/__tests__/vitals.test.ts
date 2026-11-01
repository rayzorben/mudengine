import { describe, expect, it } from 'vitest';

import { meterValue } from '../vitals';
import { t } from '../i18n';

const ofMax = (current: string, max: string): string => t('cards.party.ofMax', { current, max });

/*
 * The figure in a party member's bar. The percentage is the listing's; the
 * pair is drawn once a maximum is known, because 30% of 4,434 and 30% of 62
 * are the same bar and different emergencies.
 */
describe('the figure in a party bar', () => {
  it('is a dash when the listing has not said, whatever else is known', () => {
    expect(meterValue(null, null, null)).toBe('—');
    expect(meterValue(null, 1774, 4434)).toBe('—');
  });

  it('is the percentage alone until a maximum is known', () => {
    expect(meterValue(0.4, null, null)).toBe('40%');
    expect(meterValue(1, null, 62)).toBe('100%');
  });

  it('is the figure over the maximum once one is known', () => {
    expect(meterValue(0.3, 19, 62)).toBe(ofMax('19', '62'));
  });

  /* Like the purse and the experience: a thousands separator, so one card does
     not print `4434` where the next prints `2,199,807`. Asserted through the
     same call the code makes, because the separator is the locale's. */
  it('separates thousands the way the rest of the chrome does', () => {
    expect(meterValue(0.4, 1774, 4434)).toBe(
      ofMax((1774).toLocaleString(), (4434).toLocaleString())
    );
  });
});
