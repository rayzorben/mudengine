import { describe, expect, it } from 'vitest';

import {
  paysOf,
  pickedOf,
  picksOf,
  sellAskKey,
  sellRows,
  sells,
  weightOf,
  withAll,
  withPicked
} from '../sellWords';
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
  it('lists the floor, open then hidden, then what is carried unworn, a name one row', () => {
    const twice = character();
    twice.inventory.items.push(wireItem('silk robe'));
    const rows = sellRows(twice, CHOICES);
    expect(
      rows.map((row) => `${row.from} ${row.count} ${row.thing.name}${row.hidden ? ' hidden' : ''}`)
    ).toEqual(['floor 3 iron sword', 'floor 1 rock hidden', 'pack 2 silk robe', 'pack 1 torch']);
    // Kept by a reason, or not answered for yet: neither can be picked.
    expect(rows.map(sells)).toEqual([true, false, true, false]);
  });

  it('turns the picked rows into a count a name, and what they pay and weigh', () => {
    const rows = sellRows(character(), CHOICES);
    const sword = rows[0]!;
    sword.thing.encumbrance = 30;
    const all = withAll(new Map(), rows);
    expect(picksOf(rows, all)).toEqual([
      { name: 'iron sword', from: 'floor', count: 3 },
      { name: 'silk robe', from: 'pack', count: 1 }
    ]);
    expect(paysOf(rows, all)).toBe(825 + 3 * 300);
    expect(weightOf(rows, all, 'floor')).toBe(90);
    // The robe is unweighed, so what the pack's picks weigh is not known.
    expect(weightOf(rows, all, 'pack')).toBeNull();
    // Everything picked, All takes every pick back.
    expect(picksOf(rows, withAll(all, rows))).toEqual([]);

    // Two of the three swords, never more than lie there, and none takes the row out.
    const two = withPicked(new Map(), sword, 2);
    expect(pickedOf(sword, two)).toBe(2);
    expect(paysOf(rows, two)).toBe(600);
    expect(pickedOf(sword, withPicked(two, sword, 9))).toBe(3);
    expect(withPicked(two, sword, 0).size).toBe(0);
    // A row that cannot go is never picked, whatever the map says.
    expect(pickedOf(rows[1]!, new Map([[rows[1]!.key, 1]]))).toBe(0);
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
