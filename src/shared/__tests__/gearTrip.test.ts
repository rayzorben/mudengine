import { describe, expect, it } from 'vitest';

import { asGearPicks } from '../gearTrip';

describe('the card picks at the boundary', () => {
  it('reads each pick, and keeps a row once', () => {
    expect(
      asGearPicks([
        { item: 3, name: 'leather cap', replaces: null },
        { item: 3, name: 'leather cap', replaces: null },
        { item: 4, name: 'silver ring', replaces: 'brass ring' }
      ])
    ).toEqual([
      { item: 3, name: 'leather cap', replaces: null },
      { item: 4, name: 'silver ring', replaces: 'brass ring' }
    ]);
  });

  it('refuses the lot on one bad entry', () => {
    expect(
      asGearPicks([
        { item: 3, name: 'cap', replaces: null },
        { item: '4', name: 'x' }
      ])
    ).toBeNull();
    expect(asGearPicks([{ item: 3, name: '  ', replaces: null }])).toBeNull();
    expect(asGearPicks('cap')).toBeNull();
  });
});
