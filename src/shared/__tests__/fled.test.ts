import { describe, expect, it } from 'vitest';

import { avoided, isFledList, withFled } from '../fled';

const HOUR = 3_600_000;

describe('the monsters run from', () => {
  it('keeps one entry a monster, at the highest level it was run from', () => {
    let list = withFled([], ['The Mad Wizard'], 1, 10, HOUR);
    list = withFled(list, ['mad wizard', 'angry thug'], 3, 20, HOUR);
    list = withFled(list, ['mad wizard'], 2, 30, HOUR);
    expect(list).toEqual([
      { name: 'mad wizard', level: 3, at: 30 },
      { name: 'angry thug', level: 3, at: 20 }
    ]);
  });

  it('keeps the character off one until far enough past its level, or long enough after', () => {
    const list = withFled([], ['kobold'], 1, 0, HOUR);
    const at = (now: number, band = 2) => ({ band, forgetMs: HOUR, now });
    expect(avoided(list, 'The Kobold', 1, at(1))).not.toBeNull();
    expect(avoided(list, 'kobold', 2, at(1))).not.toBeNull();
    expect(avoided(list, 'kobold', 3, at(1))).toBeNull();
    expect(avoided(list, 'kobold', null, at(1))).not.toBeNull();
    expect(avoided(list, 'kobold', 1, at(1, 0))).toBeNull();
    expect(avoided(list, 'kobold', 1, at(HOUR))).toBeNull();
    expect(avoided(list, 'thug', 1, at(1))).toBeNull();
  });

  it('drops what the clock has forgotten when it adds', () => {
    const list = withFled([{ name: 'kobold', level: 1, at: 0 }], ['thug'], 1, HOUR, HOUR);
    expect(list.map((entry) => entry.name)).toEqual(['thug']);
  });

  it('reads back only a list it wrote', () => {
    expect(isFledList([{ name: 'kobold', level: 1, at: 0 }])).toBe(true);
    expect(isFledList([{ name: 'kobold', at: 0 }])).toBe(false);
    expect(isFledList({})).toBe(false);
  });
});
