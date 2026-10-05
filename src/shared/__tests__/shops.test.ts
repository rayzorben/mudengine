import { describe, expect, it } from 'vitest';

import { shelfLines, type Shelf } from '../shops';

const shelf = (room: string, shopName: string, price: string): Shelf => ({
  room,
  shopName,
  shop: null,
  by: null,
  at: 0,
  items: [
    { name: 'torch', quantity: 3, price, note: null },
    { name: 'arrows', quantity: null, price: 'Free', note: null }
  ]
});

describe('shelfLines', () => {
  it('lists by item, then cheapest first in copper', () => {
    const lines = shelfLines([
      shelf('1/1', 'General Store', '2 gold crowns'),
      shelf('1/2', 'Outpost', '50 silver nobles'),
      shelf('1/3', 'Odd Counter', 'a song')
    ]);
    expect(lines.map((line) => [line.item.name, line.shelf.shopName])).toEqual([
      ['arrows', 'General Store'],
      ['arrows', 'Odd Counter'],
      ['arrows', 'Outpost'],
      ['torch', 'General Store'],
      ['torch', 'Outpost'],
      // A price this client cannot read sorts last, never as free.
      ['torch', 'Odd Counter']
    ]);
    expect(lines[5]!.copper).toBeNull();
  });
});
