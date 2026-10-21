import { describe, expect, it } from 'vitest';

import { DEFAULT_ART, normalizeArt } from '../artConfig';

/* Todo 20261020-2015-01: the switch for sending unknown rooms for artwork, beside the portrait one. */
describe('the art block', () => {
  it('reads both switches, on as shipped, and keeps the shipped server for a bad address', () => {
    expect(normalizeArt({})).toEqual(DEFAULT_ART);
    expect(normalizeArt({ enabled: false, rooms: false, server: 'http://art.example' })).toEqual({
      enabled: false,
      rooms: false,
      server: DEFAULT_ART.server
    });
    expect(normalizeArt({ rooms: 'yes' }).rooms).toBe(true);
  });
});
