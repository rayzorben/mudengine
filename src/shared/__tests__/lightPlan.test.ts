import { describe, expect, it } from 'vitest';

import {
  burnSeconds,
  darkWay,
  lightsToCarry,
  planLight,
  realmLights,
  type RealmLight
} from '../lightPlan';
import { CAN_SEE_FROM, reachWanted, type CarriedLight } from '../light';

/** The shipped realms' torch and lantern, as the header states them. */
const TORCH: RealmLight = { id: 175, name: 'torch', reach: 100, uses: 800 };
const LANTERN: RealmLight = { id: 176, name: 'lantern', reach: 175, uses: 2400 };

const carried = (over: Partial<CarriedLight> = {}): CarriedLight => ({
  name: 'torch',
  reach: 100,
  charges: null,
  lit: false,
  ...over
});

describe('the realm lights a shop sells', () => {
  it('takes a light with a reach and a stockist, and reads -1 uses as none stated', () => {
    const lights = realmLights([
      { id: 175, name: 'torch', kind: 'light', abilities: [[54, 100]], uses: 800, shops: ['GS'] },
      { id: 692, name: 'marsh light', kind: 'light', abilities: [[54, 200]], uses: 9999 },
      { id: 284, name: 'incense', kind: 'light', abilities: [[43, 118]], uses: 1, shops: ['C'] },
      { id: 9, name: 'grey robes', kind: 'armour', shops: ['Robes'] },
      { id: 300, name: 'lamp', kind: 'light', abilities: [[54, 50]], uses: -1, shops: ['C'] }
    ]);
    expect(lights).toEqual([
      { id: 175, name: 'torch', reach: 100, uses: 800 },
      { id: 300, name: 'lamp', reach: 50, uses: null }
    ]);
  });
});

describe('how long a light burns', () => {
  it('loses ten uses every thirty seconds, so a torch lasts forty minutes', () => {
    expect(burnSeconds(800)).toBe(2400);
    expect(burnSeconds(15)).toBe(60);
    expect(burnSeconds(null)).toBeNull();
  });
});

describe('the dark steps of a way', () => {
  it('counts only rooms the realm records too dark for this character', () => {
    const way = darkWay([{}, { light: -175 }, { light: 0 }, {}, { light: -999 }, {}], 0, false);
    expect(way).toEqual({ reaches: [25, 849], span: 4 });
  });

  it('is nothing where vision reads every room, and widens to dim rooms when asked', () => {
    expect(darkWay([{ light: -175 }], 200, false)).toBeNull();
    expect(darkWay([{ light: -50 }], 0, false)).toBeNull();
    expect(darkWay([{ light: -50 }], 0, true)).toEqual({ reaches: [50], span: 1 });
  });

  it('solves the reach for the same test the light is lit by', () => {
    expect(-175 + 0 + reachWanted(-175, 0, false)).toBe(CAN_SEE_FROM);
    expect(-50 + 10 + reachWanted(-50, 10, true)).toBe(0);
  });
});

describe('what to do about it', () => {
  const way = { reaches: [75], span: 1 };

  it('buys every sold light that reaches, where the inventory has none', () => {
    expect(planLight(way, [], [TORCH, LANTERN])).toEqual({
      kind: 'buy',
      lights: [TORCH, LANTERN],
      unlit: 0
    });
  });

  it('buys nothing with a usable light that reaches, or one of unstated reach', () => {
    expect(planLight(way, [carried()], [TORCH])).toEqual({ kind: 'carried' });
    expect(planLight(way, [carried({ reach: null })], [TORCH])).toEqual({ kind: 'carried' });
  });

  it('buys over a spent light, and over one too weak', () => {
    expect(planLight(way, [carried({ charges: 0 })], [TORCH]).kind).toBe('buy');
    const deep = { reaches: [150], span: 1 };
    expect(planLight(deep, [carried()], [TORCH, LANTERN])).toEqual({
      kind: 'buy',
      lights: [LANTERN],
      unlit: 0
    });
  });

  it('aims at the most anything sold reaches, and counts the rooms left dark', () => {
    const deep = { reaches: [75, 849], span: 2 };
    expect(planLight(deep, [], [TORCH, LANTERN])).toEqual({
      kind: 'buy',
      lights: [LANTERN],
      unlit: 1
    });
  });

  it('says why where nothing can be bought', () => {
    expect(planLight(way, [], [])).toEqual({ kind: 'none', reason: 'nothing sold' });
    expect(planLight({ reaches: [849], span: 1 }, [], [TORCH])).toEqual({
      kind: 'none',
      reason: 'nothing reaches'
    });
  });
});

describe('how many to carry', () => {
  it('is as many as burn for the dark stretch, never under the floor', () => {
    expect(lightsToCarry(10, 1250, 800, 1)).toBe(1);
    // 3,000 steps at 1.25s is 3,750s against a torch's 2,400.
    expect(lightsToCarry(3000, 1250, 800, 1)).toBe(2);
    expect(lightsToCarry(10, 1250, 800, 2)).toBe(2);
  });

  it('is the floor where the realm states no uses', () => {
    expect(lightsToCarry(3000, 1250, null, 1)).toBe(1);
  });
});
