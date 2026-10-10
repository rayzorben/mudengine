import { describe, expect, it } from 'vitest';

import { t } from '../i18n';
import { visitedAgo } from '../visited';

const NOW = 1_000_000_000_000;
const minutes = (n: number): number => NOW - n * 60_000;

describe('when a walk to a room last started', () => {
  it('says the hours and the minutes after them', () => {
    expect(visitedAgo(minutes(62), NOW)).toBe(t('rooms.visited.hours', { hours: 1, minutes: 2 }));
  });

  it('floors every step, so a walk is never made more recent', () => {
    expect(visitedAgo(NOW - 59_999, NOW)).toBe(t('rooms.visited.justNow'));
    expect(visitedAgo(minutes(59) - 59_000, NOW)).toBe(t('rooms.visited.minutes', { minutes: 59 }));
    expect(visitedAgo(minutes(24 * 60 + 61), NOW)).toBe(
      t('rooms.visited.days', { days: 1, hours: 1 })
    );
  });
});
