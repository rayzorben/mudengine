import { describe, expect, it } from 'vitest';

import { bestOfSlot, placesOf, sheetGain, withinBudget, worth } from '../gearWorth';
import { REALM_ARMOUR_SCALE } from '../menace';

const armour = (ac: number) => ({ expPerHour: null, armourClass: ac, perRound: null });

function option(slot: string, item: number, gain: number, copper: number) {
  return { slot, item, gain: armour(gain), copper };
}

describe('what an item is worth', () => {
  it('reads armour over what is worn, on the realm scale', () => {
    expect(sheetGain({ ranking: 'armour', wornFigure: 10 }, { figure: 30 }, null).armourClass).toBe(
      20 / REALM_ARMOUR_SCALE
    );
  });

  it('keeps out an item whose survey says it costs exp', () => {
    expect(
      worth({ gain: { expPerHour: -5, armourClass: 3, perRound: null }, copper: 1 })
    ).toBeNull();
  });

  it('gives a tie to the cheaper item', () => {
    const items = [option('Head', 1, 2, 500), option('Head', 2, 2, 100)];
    expect(bestOfSlot(items, (each) => each)?.item).toBe(2);
  });

  it('counts the ring fingers as two places', () => {
    expect(placesOf('Finger')).toBe(2);
    expect(placesOf('Head')).toBe(1);
  });
});

describe('what a budget buys', () => {
  it('takes the slot giving most per copper first, then the best the copper left covers', () => {
    const options = [
      option('Head', 1, 4, 1000),
      option('Head', 2, 1, 100),
      option('Legs', 3, 3, 300),
      option('Legs', 4, 6, 5000)
    ];
    // Legs at 1 a hundred copper first, then the best head the 700 left buys.
    expect(withinBudget(options, 1000).map((each) => each.item)).toEqual([3, 2]);
    expect(withinBudget(options, 0)).toEqual([]);
  });

  it('fills as many places as a slot has, never one item twice', () => {
    const options = [option('Finger', 1, 2, 10), option('Finger', 2, 1, 10)];
    expect(withinBudget(options, 100).map((each) => each.item)).toEqual([1, 2]);
    expect(withinBudget(options, 100, () => 1).map((each) => each.item)).toEqual([1]);
  });
});
