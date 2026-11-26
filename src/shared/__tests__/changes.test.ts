import { describe, expect, it } from 'vitest';

import { changedPaths } from '../changes';

describe('changedPaths', () => {
  it('names each leaf that moved, with both values', () => {
    const before = { health: { restBelow: 0.5, restTo: 0.75 }, enabled: true };
    const after = { health: { restBelow: 0.4, restTo: 0.75 }, enabled: true };
    expect(changedPaths(before, after)).toEqual(['health.restBelow: 0.5 → 0.4']);
  });

  it('reports a key that appeared or went away', () => {
    expect(changedPaths({ a: 1 }, { b: 2 })).toEqual(['a: 1 → undefined', 'b: undefined → 2']);
  });

  it('compares an array whole and reports nothing for an equal one', () => {
    expect(changedPaths({ keep: ['a'] }, { keep: ['a'] })).toEqual([]);
    expect(changedPaths({ keep: ['a'] }, { keep: ['a', 'b'] })).toEqual([
      'keep: ["a"] → ["a","b"]'
    ]);
  });
});
