import { describe, expect, it } from 'vitest';

import { nearestOf, placesOfKind, type KindParts } from '../placeDesk';
import { UNKNOWN_WEARER } from '../../../shared/gear';
import {
  roomId,
  type CounterPlace,
  type TrainerChoice,
  type WorldItem,
  type WorldShop
} from '../../../shared/world';

const MAGE = 5;

/** A sword shop, a Warrior-only axe shop, a deed shop, a bank and a recycler that restocks nothing. */
const SHOPS: Array<{ shop: WorldShop; at: CounterPlace }> = [
  { id: 1, name: 'Sword Shop', items: [{ id: 10, name: 'broadsword' }] },
  { id: 2, name: 'Axes', items: [{ id: 11, name: 'battleaxe' }] },
  { id: 3, name: 'Realm Deed Shop', items: [{ id: 12, name: 'red parchment deed' }] },
  { id: 4, name: 'Bank of Godfrey', items: [], kind: 'bank' as const },
  {
    id: 5,
    name: 'Recycler Shop',
    items: [{ id: 10, name: 'broadsword', restocks: false as const }]
  }
].map((shop, at) => ({
  shop,
  at: { shop: shop.id, name: shop.name, map: 1, room: at + 1, roomName: shop.name }
}));

const ITEMS: Record<number, WorldItem> = {
  10: { id: 10, name: 'broadsword', kind: 'weapon', slot: 'weapon hand' },
  11: { id: 11, name: 'battleaxe', kind: 'weapon', slot: 'weapon hand', classes: [1] },
  12: { id: 12, name: 'red parchment deed', kind: 'armour' }
};

function parts(classId: number | null = null, trainers: TrainerChoice[] = []): KindParts {
  return {
    world: {
      counters: (want) => SHOPS.filter(({ shop }) => want(shop)).map(({ at }) => at),
      item: (id) => ITEMS[id]
    },
    trainers: () => trainers,
    wearer: { ...UNKNOWN_WEARER, classId }
  };
}

describe('placesOfKind', () => {
  it('finds a weapon counter by what it restocks, not by its type', () => {
    expect(placesOfKind('weapons', parts()).map((p) => p.name)).toEqual(['Sword Shop', 'Axes']);
  });

  it('leaves out a counter whose every line of the kind the class may not wear', () => {
    expect(placesOfKind('weapons', parts(MAGE)).map((p) => p.name)).toEqual(['Sword Shop']);
  });

  it('keeps a counter whose weapon only an alignment refuses: alignment changes in play', () => {
    const at: CounterPlace = { shop: 6, name: 'Dark Blades', map: 1, room: 6, roomName: 'Alley' };
    const blades: WorldShop = {
      id: 6,
      name: 'Dark Blades',
      items: [{ id: 13, name: 'hellblade' }]
    };
    const hellblade: WorldItem = {
      ...{ id: 13, name: 'hellblade', kind: 'weapon', slot: 'weapon hand' },
      abilities: [[98, 250]]
    };
    const evilOnly: KindParts = {
      world: { counters: (want) => (want(blades) ? [at] : []), item: () => hellblade },
      trainers: () => [],
      wearer: { ...UNKNOWN_WEARER, alignment: 'Saint' }
    };
    expect(placesOfKind('weapons', evilOnly)).toEqual([at]);
  });

  it('never calls a deed shop an armourer: a deed is worn nowhere', () => {
    expect(placesOfKind('armour', parts())).toEqual([]);
  });

  it('answers a bank by the shop kind', () => {
    expect(placesOfKind('bank', parts()).map((p) => p.name)).toEqual(['Bank of Godfrey']);
  });

  it('takes the trainers already filtered for level and class', () => {
    const trainer: TrainerChoice = {
      shop: 40,
      name: 'Mage Training Room',
      map: 1,
      room: 9,
      roomName: 'Guild',
      cost: 100,
      minLevel: 1,
      maxLevel: 10
    };
    expect(placesOfKind('trainer', parts(MAGE, [trainer]))).toEqual([trainer]);
  });
});

describe('nearestOf', () => {
  it('orders by moves, drops what the sweep never reached, and breaks ties by name', () => {
    const places = SHOPS.map(({ at }) => at);
    const moves = new Map([
      [roomId(1, 2), 7],
      [roomId(1, 1), 3],
      [roomId(1, 4), 3]
    ]);
    expect(nearestOf(places, moves).map(({ place, moves: m }) => [place.name, m])).toEqual([
      ['Bank of Godfrey', 3],
      ['Sword Shop', 3],
      ['Axes', 7]
    ]);
  });
});
