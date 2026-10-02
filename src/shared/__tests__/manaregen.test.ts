import { describe, expect, it } from 'vitest';

import { measuredManaRate, NO_MANA_WATCH, watchMana, type ManaSample } from '../manaregen';

const line = (seconds: number, mana: number, over: Partial<ManaSample> = {}): ManaSample => ({
  at: seconds * 1000,
  mana,
  manaMax: 30,
  inCombat: false,
  resting: false,
  meditating: false,
  ...over
});

function watched(lines: ManaSample[]) {
  return lines.reduce((watch, sample) => watchMana(watch, sample, 45), NO_MANA_WATCH);
}

describe('mana regeneration measured off the statline', () => {
  it('counts the rise standing short of full, and trusts it only once long enough', () => {
    const watch = watched([line(0, 10), line(30, 12), line(60, 14), line(90, 16)]);
    expect(watch).toMatchObject({ seconds: 90, gained: 6 });
    expect(measuredManaRate(watch, 60)).toBeCloseTo(6 / 90);
    expect(measuredManaRate(watch, 120)).toBeNull();
  });

  it('passes over a fight, a rest, a meditation, a cast, a full pool and a long gap', () => {
    const watch = watched([
      line(0, 10),
      line(30, 12, { inCombat: true }),
      line(60, 14),
      line(90, 15, { meditating: true }),
      line(120, 16),
      line(150, 11),
      line(180, 11, { resting: true }),
      line(210, 30),
      line(240, 30),
      line(440, 20),
      line(470, 21)
    ]);
    // Only 440 → 470 counts: every other stretch had a reason to be passed over.
    expect(watch).toMatchObject({ seconds: 30, gained: 1 });
  });

  it('keeps an unread pool unread', () => {
    expect(watched([line(0, 10, { mana: null }), line(30, 12)]).seconds).toBe(0);
  });
});
