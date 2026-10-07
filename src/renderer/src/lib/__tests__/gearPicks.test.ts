import { describe, expect, it } from 'vitest';

import { basketOf, cashAt, costOf, picksOf, roomFor, toggled, tripPicks } from '../gearPicks';
import type { GearChoice, GearChoices, GearSlot } from '@shared/upgrades';

function item(slot: string, id: number, ac: number, charged: number | null): GearChoice {
  return {
    item: id,
    name: `item ${id}`,
    figure: ac,
    ac,
    dr: null,
    minLevel: null,
    sold:
      charged === null
        ? null
        : { shop: 'Armoury', at: { map: 1, room: 2 }, moves: 3, copper: charged },
    droppedBy: [],
    counters: charged === null ? 0 : 1,
    slot,
    charged,
    gain: { expPerHour: null, armourClass: ac, perRound: null }
  };
}

function slot(name: string, items: GearChoice[], over: Partial<GearSlot> = {}): GearSlot {
  return {
    slot: name,
    worn: null,
    wornFigure: null,
    wornDr: null,
    free: 1,
    ranking: 'armour',
    places: 1,
    items,
    ...over
  };
}

const CHOICES: GearChoices = {
  unread: false,
  slots: [
    slot('Head', [item('Head', 1, 4, 1000), item('Head', 2, 1, 100)]),
    slot('Finger', [item('Finger', 3, 2, 50), item('Finger', 4, 1, 40)], {
      places: 2,
      free: 0,
      worn: 'brass ring'
    }),
    slot('Legs', [item('Legs', 5, 9, null)])
  ]
};

describe('the Gear card picks', () => {
  it('reaches the purse and every vault, and nothing where neither is read', () => {
    expect(cashAt(100, [{ copper: 900 }])).toBe(1000);
    expect(cashAt(null, [])).toBeNull();
  });

  it('buys one ring in place of the weakest when every finger is worn', () => {
    expect(roomFor(CHOICES.slots[1]!)).toBe(1);
    const basket = basketOf(CHOICES, 200);
    expect(basket.get('Finger')?.map((each) => each.item)).toEqual([3]);
    expect(tripPicks(CHOICES, basket)).toContainEqual({
      item: 3,
      name: 'item 3',
      replaces: 'brass ring'
    });
  });

  it('lays the player picks over the budget, and counts what has no price', () => {
    const basket = basketOf(CHOICES, 200);
    const picked = picksOf(CHOICES, basket, { Head: [1], Legs: [5], Finger: [] });
    expect([...picked.keys()]).toEqual(['Head', 'Legs']);
    expect(costOf(picked)).toEqual({ copper: 1000, unpriced: 1, count: 2 });
  });

  it('swaps a one-place pick and adds to a ring kind up to its room', () => {
    expect(toggled(CHOICES.slots[0]!, [1], 2)).toEqual([2]);
    expect(toggled(CHOICES.slots[0]!, [1], 1)).toEqual([]);
    const fingers = slot('Finger', [], { places: 2, free: 2 });
    expect(toggled(fingers, [3], 4)).toEqual([3, 4]);
  });
});
