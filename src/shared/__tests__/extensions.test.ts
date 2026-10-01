import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../config';
import { asManifest, unknownWrites, withLayer } from '../extensions';

describe('a layer of settings', () => {
  it('sets each path on a copy, and leaves the character’s own alone', () => {
    const own = DEFAULT_CONFIG.automation;
    const laid = withLayer(own, [
      [['combat', 'attack'], 'kic'],
      [['health', 'restBelow'], 0.7]
    ]);
    expect(laid.combat.attack).toBe('kic');
    expect(laid.health.restBelow).toBe(0.7);
    expect(own.combat.attack).not.toBe('kic');
  });

  it('never grows the settings: a path to nothing is skipped', () => {
    const laid = withLayer(DEFAULT_CONFIG.automation, [
      [['combat', 'invented'], 1],
      [['nowhere', 'at', 'all'], 2],
      [[], 3]
    ]);
    expect(laid).toEqual(DEFAULT_CONFIG.automation);
    expect(
      unknownWrites(DEFAULT_CONFIG.automation, [
        [['combat', 'attack'], 'kic'],
        [['combat', 'invented'], 1],
        [['combat', 'constructor'], 1],
        [['__proto__', 'toString'], 1]
      ]).map(([path]) => path.join('.'))
    ).toEqual(['combat.invented', 'combat.constructor', '__proto__.toString']);
  });
});

describe('a manifest', () => {
  it('names its own folder, a title and a main file', () => {
    expect(asManifest({ name: 'a', title: 'A', main: 'm.mjs' }, 'a')).toEqual({
      name: 'a',
      title: 'A',
      main: 'm.mjs'
    });
    expect(asManifest({ name: 'b', title: 'A', main: 'm.mjs' }, 'a')).toBeNull();
    expect(asManifest({ name: 'a', title: 'A', main: 'm.mjs', ui: 3 }, 'a')).toBeNull();
    expect(asManifest(null, 'a')).toBeNull();
    // The window reads a page's host in lower case.
    expect(asManifest({ name: 'Planner', title: 'A', main: 'm.mjs' }, 'Planner')).toBeNull();
  });
});
