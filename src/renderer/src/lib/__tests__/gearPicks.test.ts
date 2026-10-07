import { describe, expect, it } from 'vitest';

import {
  buysOf,
  cashAt,
  costOf,
  declineKey,
  roomFor,
  suggestionsOf,
  toggled,
  tripPicks
} from '../gearPicks';
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
    const suggested = suggestionsOf(CHOICES, 200, {});
    expect(suggested.get('Finger')?.map((each) => each.item)).toEqual([3]);
    expect(tripPicks(CHOICES, suggested)).toContainEqual({
      item: 3,
      name: 'item 3',
      replaces: 'brass ring'
    });
  });

  it('pays for what the player chose first, and suggests the rest from what is left', () => {
    // The 1,000 copper helm chosen leaves 45 of 1,045: the 50 copper ring no longer fits.
    const suggested = suggestionsOf(CHOICES, 1045, { Head: [1] });
    expect(suggested.get('Head')?.map((each) => each.item)).toEqual([1]);
    expect(suggested.get('Finger')?.map((each) => each.item)).toEqual([4]);
  });

  it('leaves a declined suggestion out of the buys, and counts what has no price', () => {
    const suggested = suggestionsOf(CHOICES, 200, { Legs: [5] });
    const buys = buysOf(suggested, new Set([declineKey('Finger', 3)]));
    expect([...buys.keys()].sort()).toEqual(['Head', 'Legs']);
    expect(costOf(buys)).toEqual({ copper: 100, unpriced: 1, count: 2 });
  });

  it('swaps a one-place pick and adds to a ring kind up to its room', () => {
    expect(toggled(CHOICES.slots[0]!, [1], 2)).toEqual([2]);
    expect(toggled(CHOICES.slots[0]!, [1], 1)).toEqual([]);
    const fingers = slot('Finger', [], { places: 2, free: 2 });
    expect(toggled(fingers, [3], 4)).toEqual([3, 4]);
  });
});
