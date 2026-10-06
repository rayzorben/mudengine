import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { ItemEntity } from '../../../shared/entities';
import { UNKNOWN_WEARER } from '../../../shared/gear';
import type { ProwessSheet } from '../../../shared/prowess';
import type { WorldItem } from '../../../shared/world';
import { outgrownItems, type OutgrownRealm } from '../outgrownItems';

const SHEET: ProwessSheet = {
  level: 20,
  agility: 60,
  intellect: 50,
  charm: 50,
  willpower: 50,
  health: 60,
  strength: 60,
  spellcasting: 0,
  combatLevel: 4,
  mageryLevel: null,
  encumbrancePercent: 10
};

const piece = (id: number, name: string, worn: number, ac: number, price = 20): WorldItem =>
  ({ id, name, worn, kind: 'armour', armour: { ac }, price, currency: 'silver' }) as WorldItem;

/* Soul's pack, 2026-10-01: sandals and cloth shoes at 10 AC each, a leather belt, two rings. */
const ITEMS = [
  piece(1, 'sandals', 5, 10),
  piece(2, 'cloth shoes', 5, 10),
  piece(3, 'leather boots', 5, 20),
  piece(4, 'iron ring', 4, 1),
  piece(5, 'silver ring', 4, 2, 50)
];

const realm: OutgrownRealm = {
  itemsWornIn: (worn) => ITEMS.filter((item) => item.worn === worn),
  item: (id) => ITEMS.find((item) => item.id === id),
  rarity: (id) => (id === 5 ? 'rare' : 'common')
};

const asker = { wearer: UNKNOWN_WEARER, sheet: SHEET, family: 'greatermud' as const, attack: 'a' };

function carrying(...items: Array<Partial<ItemEntity>>): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    inventory: {
      ...base.inventory,
      items: items.map(
        (item) =>
          ({ source: 'wire', slot: null, charges: null, equipped: false, ...item }) as ItemEntity
      )
    }
  };
}

const row = (id: number): Partial<ItemEntity> => {
  const item = ITEMS.find((each) => each.id === id)!;
  return { name: item.name, id, wornSlotCode: item.worn, armour: item.armour };
};

describe('the gear the character has outgrown', () => {
  it('is an unworn item no better than what is worn in its full slot, with its price in copper', () => {
    const state = carrying({ ...row(2), equipped: true }, row(1));
    expect(outgrownItems(state, realm, asker)).toEqual([
      expect.objectContaining({ slot: 'Feet', worn: 'cloth shoes', copper: 200 })
    ]);
  });

  it('is not an item better than the worn one', () => {
    const state = carrying({ ...row(1), equipped: true }, row(3));
    expect(outgrownItems(state, realm, asker)).toEqual([]);
  });

  it('is not an item for a slot with room in it, as a second ring finger has', () => {
    const state = carrying({ ...row(5), equipped: true }, row(4));
    expect(outgrownItems(state, realm, asker)).toEqual([]);
    const full = carrying({ ...row(5), equipped: true }, { ...row(5), equipped: true }, row(4));
    expect(outgrownItems(full, realm, asker).map((found) => found.item.name)).toEqual([
      'iron ring'
    ]);
  });

  it('is not an item for a slot nothing is worn in', () => {
    expect(outgrownItems(carrying(row(1)), realm, asker)).toEqual([]);
  });

  it('has no price where the rows a shared name holds disagree', () => {
    const shared = { ...row(1), id: 1, ids: [1, 5] };
    const state = carrying({ ...row(2), equipped: true }, shared);
    expect(outgrownItems(state, realm, asker)[0]?.copper).toBeNull();
  });

  it("carries the realm's rarity, unknown where the rows a shared name holds disagree", () => {
    const state = carrying({ ...row(2), equipped: true }, row(1));
    expect(outgrownItems(state, realm, asker)[0]?.rarity).toBe('common');
    const shared = carrying({ ...row(2), equipped: true }, { ...row(1), ids: [1, 5] });
    expect(outgrownItems(shared, realm, asker)[0]?.rarity).toBe('unknown');
  });

  /* Todo 14: Soul carried 12 spare iron-capped staffs beside the one in hand. */
  it('is a spare of the item worn', () => {
    const state = carrying({ ...row(2), equipped: true }, row(2));
    expect(outgrownItems(state, realm, asker)).toEqual([
      expect.objectContaining({
        worn: 'cloth shoes',
        item: expect.objectContaining({ name: 'cloth shoes' })
      })
    ]);
  });
});
