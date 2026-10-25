import { describe, expect, it } from 'vitest';

import { regenClockText, residentClockText } from '../clockText';

// Format 74: a resident's clock is its own reading, never the lair slot's `regenHours`.
describe('a monster’s clocks as text', () => {
  it('reads the resident clock apart from the regen time', () => {
    const dummy = { residentHours: 24 };
    expect(regenClockText({ ...dummy, regenHours: undefined })).toBeNull();
    expect(residentClockText(dummy)).toBe(regenClockText({ regenHours: 24 }));
    expect(residentClockText({})).toBeNull();
  });
});
