import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { wireItem } from '../../../shared/entities';
import type { BuyingPlace, WorldItem, WorldSpell } from '../../../shared/world';
import { blessItems, type BlessItemRealm } from '../blessItems';

// AC 50 is 5 on the sheet; targets 1 is self, 13 the party in the room, 2 another player.
const SPELLS: Record<number, WorldSpell> = {
  10: { id: 10, name: 'faith', duration: 60, targets: 13, abilities: [[2, 50]] },
  11: { id: 11, name: 'stoneskin', duration: 60, targets: 1, abilities: [[7, 30]] },
  12: { id: 12, name: 'blessing of another', duration: 60, targets: 2, abilities: [[2, 50]] },
  13: { id: 13, name: 'drunk', duration: 60, targets: 1, abilities: [[200, 1]] }
};

const ITEMS: WorldItem[] = [
  {
    id: 1,
    name: 'cloak of faith',
    kind: 'armour',
    uses: 3,
    retains: true,
    abilities: [
      [121, 3],
      [43, 10]
    ],
    from: [{ kind: 'asked', who: 'Chancellor Annora' }]
  },
  { id: 2, name: 'stone potion', uses: 1, abilities: [[43, 11]] },
  { id: 3, name: 'blessed rod', uses: -1, abilities: [[43, 11]], mobs: ['orc'] },
  { id: 4, name: 'rod of another', uses: -1, abilities: [[43, 12]] },
  { id: 5, name: 'ale', uses: 1, abilities: [[43, 13]] },
  { id: 6, name: 'high rod', uses: -1, minLevel: 30, abilities: [[43, 11]] },
  { id: 7, name: 'carried rod', uses: -1, abilities: [[43, 11]] }
];

const realm: BlessItemRealm = {
  itemsWhere: (test) => ITEMS.filter(test),
  spellById: (id) => SPELLS[id] ?? null,
  // The potion is sold two steps off; nothing else is sold.
  stockingPlaces: (items) =>
    items
      .filter((item) => item === 2)
      .map((item): BuyingPlace & { item: number } => ({
        item,
        map: 1,
        room: 5,
        roomName: 'Apothecary',
        shop: 'Apothecary',
        markup: 0,
        detour: 2,
        moves: 2
      })),
  priceAt: () => 120,
  dropsOf: (item) => ITEMS.find((row) => row.name === item)?.mobs ?? []
};

function character(level: number | null): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    progress: { ...base.progress, level },
    inventory: { ...base.inventory, items: [{ ...wireItem('carried rod'), equipped: false }] }
  };
}

describe('the bless items the realm has for this character', () => {
  it('lists what lands on the user and adds something, renewing first, then the nearest', () => {
    const items = blessItems(character(10), realm);
    expect(items?.map((item) => item.name)).toEqual([
      'blessed rod',
      'cloak of faith',
      'stone potion'
    ]);
    const [rod, cloak, potion] = items!;
    expect(cloak).toMatchObject({
      spell: 'faith',
      party: true,
      renews: true,
      adds: [{ figure: 'armourClass', value: 5 }],
      givenBy: ['Chancellor Annora']
    });
    expect(rod).toMatchObject({ renews: true, droppedBy: ['orc'], sold: null });
    expect(potion).toMatchObject({
      renews: false,
      sold: { shop: 'Apothecary', moves: 2, copper: 120 },
      adds: [{ figure: 'damageResist', value: 3 }]
    });
  });

  it('says nothing while the level is unread', () => {
    expect(blessItems(character(null), realm)).toBeNull();
  });

  it('lists an item above the level once the level reaches it', () => {
    expect(blessItems(character(30), realm)?.map((item) => item.name)).toContain('high rod');
  });
});
