import { describe, expect, it } from 'vitest';

import type { Logged } from '../../../shared/finds';
import type { FloorSeen } from '../../../shared/floor';
import type { Shelf } from '../../../shared/shops';
import { itemSeen, type SeenWorld } from '../itemSeen';

const PIKE = { id: 40, name: 'golden pike' };

/** A realm whose index settles the plural, as `Catalogue.itemIdNamed` does. */
const world: SeenWorld = {
  itemIdNamed: (name) => (name === 'golden pike' || name === 'golden pikes' ? 40 : null)
};

const floor: FloorSeen[] = [
  { room: '1/1', roomName: 'Town Gates', name: 'golden pike', first: 10, at: 30 },
  { room: '1/2', roomName: 'Estwall Street', name: 'rusty key', first: 5, at: 5 }
];

const shelves: Shelf[] = [
  {
    room: '1/9',
    shopName: 'Weapon Shop',
    shop: 3,
    by: 'Festus',
    at: 20,
    items: [
      { name: 'golden pikes', quantity: 2, price: '40 gold crowns', note: null },
      { name: 'dagger', quantity: 9, price: '10 silver nobles', note: null }
    ]
  }
];

const find = (over: Partial<Logged>): Logged => ({
  room: '2/7',
  roomName: 'Old Cellar',
  name: 'Golden Pike',
  quantity: null,
  copper: null,
  coins: null,
  at: 40,
  seen: 3,
  hits: 3,
  searched: 5,
  ...over
});

describe('where an item was seen', () => {
  it('joins the floors, the shop lists and the searches, newest first', () => {
    const seen = itemSeen([PIKE], { floor, shelves, finds: [find({})] }, world);
    expect(seen[40]).toEqual([
      { where: 'search', room: '2/7', roomName: 'Old Cellar', at: 40, seen: 3 },
      { where: 'floor', room: '1/1', roomName: 'Town Gates', first: 10, at: 30 },
      {
        where: 'shop',
        room: '1/9',
        roomName: 'Weapon Shop',
        at: 20,
        price: '40 gold crowns',
        quantity: 2
      }
    ]);
  });

  it('leaves out cash a search turned up and an item seen nowhere', () => {
    const dagger = [{ id: 7, name: 'dagger' }];
    const none = { floor: [], shelves: [] };
    // Positive control: the same row as a thing is joined.
    expect(itemSeen(dagger, { ...none, finds: [find({ name: 'dagger' })] }, world)[7]).toHaveLength(
      1
    );
    expect(
      itemSeen(dagger, { ...none, finds: [find({ name: 'dagger', copper: 1000 })] }, world)
    ).toEqual({});
    expect(itemSeen([{ id: 8, name: 'war hammer' }], { floor, shelves, finds: [] }, world)).toEqual(
      {}
    );
  });

  it('gives every row of a shared name the same sightings', () => {
    const rows = [PIKE, { id: 41, name: 'golden pike' }];
    const seen = itemSeen(rows, { floor, shelves: [], finds: [] }, world);
    expect(seen[40]).toEqual(seen[41]);
    expect(seen[41]).toHaveLength(1);
  });
});
