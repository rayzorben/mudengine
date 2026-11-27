import { describe, expect, it } from 'vitest';

import { paysOf, picksOf, sellAskKey, sellRows, sells } from '../sellWords';
import { EMPTY_CHARACTER, type CharacterState } from '@shared/character';
import { wireItem } from '@shared/entities';
import type { SellChoice } from '@shared/sellRun';

const character = (): CharacterState => ({
  ...structuredClone(EMPTY_CHARACTER),
  room: {
    ...EMPTY_CHARACTER.room,
    map: 1,
    number: 5,
    items: [wireItem('iron sword', { count: 3 })],
    hidden: [wireItem('rock')]
  },
  inventory: {
    ...EMPTY_CHARACTER.inventory,
    items: [wireItem('silk robe'), wireItem('silk robe', { equipped: true }), wireItem('torch')]
  }
});

const choice = (over: Partial<SellChoice> & Pick<SellChoice, 'name' | 'from'>): SellChoice => ({
  count: 1,
  copper: 100,
  shop: 'Armoury',
  moves: 3,
  kept: null,
  ...over
});
const CHOICES: SellChoice[] = [
  choice({ name: 'silk robe', from: 'pack', copper: 825 }),
  choice({
    name: 'torch',
    from: 'pack',
    copper: null,
    shop: null,
    moves: null,
    kept: 'no-counter'
  }),
  choice({ name: 'iron sword', from: 'floor', count: 3, copper: 300 })
];

describe('the Sell face`s rows', () => {
  it('lists what is carried unworn, then the floor, a pile one row', () => {
    const rows = sellRows(character(), CHOICES);
    expect(rows.map((row) => `${row.from} ${row.count} ${row.thing.name}`)).toEqual([
      'pack 1 silk robe',
      'pack 1 torch',
      'floor 3 iron sword',
      'floor 1 rock'
    ]);
    // Kept by a reason, or not answered for yet: neither can be picked.
    expect(rows.map(sells)).toEqual([true, false, true, false]);
  });

  it('turns the picked rows into a count a name, and what they pay', () => {
    const rows = sellRows(character(), CHOICES);
    const picked = new Set(rows.map((row) => row.key));
    expect(picksOf(rows, picked)).toEqual([
      { name: 'silk robe', from: 'pack', count: 1 },
      { name: 'iron sword', from: 'floor', count: 3 }
    ]);
    expect(paysOf(rows, picked)).toBe(825 + 3 * 300);
    expect(picksOf(rows, new Set())).toEqual([]);
  });

  it('asks again when the pack, the floor or the room moves', () => {
    const before = sellAskKey(character());
    const moved = character();
    moved.room.number = 6;
    const worn = character();
    worn.inventory.items[0]!.equipped = true;
    const taken = character();
    taken.room.items = [];
    expect(new Set([before, sellAskKey(moved), sellAskKey(worn), sellAskKey(taken)]).size).toBe(4);
    expect(sellAskKey(character())).toBe(before);
  });
});
