import { describe, expect, it } from 'vitest';

import { saleOnTheWay, type SaleReads } from '../saleOnTheWay';
import { DEFAULT_OUTGROWN } from '../../../shared/packConfig';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { ItemEntity } from '../../../shared/entities';
import type { Rarity } from '../../../shared/rarity';
import type { BuyingPlace, RoomId } from '../../../shared/world';

const BANK = '1/20' as RoomId;

/** Realm rows by id: a name, a price in copper and a rarity. */
const ROWS: Record<number, { name: string; price: number; rarity: Rarity }> = {
  1: { name: 'rusty dagger', price: 2000, rarity: 'common' },
  2: { name: 'bone charm', price: 3000, rarity: 'uncommon' },
  3: { name: 'leather cap', price: 2000, rarity: 'common' },
  4: { name: 'iron key', price: 2000, rarity: 'common' },
  5: { name: 'torch', price: 2000, rarity: 'common' },
  6: { name: 'scale mail', price: 2000, rarity: 'common' },
  7: { name: 'token of Silvermere', price: 2000, rarity: 'common' },
  8: { name: 'star sapphire', price: 2000, rarity: 'rare' },
  9: { name: 'gold idol', price: 50_000, rarity: 'common' },
  10: { name: 'troll hide', price: 2000, rarity: 'common' },
  11: { name: 'wooden cup', price: 1, rarity: 'common' },
  12: { name: 'blessed ankh', price: 2000, rarity: 'common' },
  13: { name: 'old map', price: 2000, rarity: 'common' }
};

const ROW_OF = new Map(Object.entries(ROWS).map(([id, row]) => [row.name, Number(id)]));
/** A carried item, settled to its one realm row as the tracker does. */
const item = (name: string, over: Partial<ItemEntity> = {}): ItemEntity =>
  ({ name, equipped: false, ids: [ROW_OF.get(name)!], ...over }) as ItemEntity;

const place = (
  id: number,
  room: number,
  shop: string,
  detour: number
): BuyingPlace & { item: number } => ({
  item: id,
  map: 1,
  room,
  roomName: shop,
  shop,
  markup: 0,
  detour,
  moves: detour
});

function reads(
  pack: ItemEntity[],
  places: Array<BuyingPlace & { item: number }>,
  over: Partial<SaleReads> = {}
): SaleReads & { asked: number[][] } {
  const state: CharacterState = {
    ...structuredClone(EMPTY_CHARACTER),
    room: { ...EMPTY_CHARACTER.room, map: 1, number: 0 },
    inventory: { ...EMPTY_CHARACTER.inventory, items: pack },
    progress: { ...EMPTY_CHARACTER.progress, charm: 50 }
  };
  const asked: number[][] = [];
  return {
    asked,
    current: () => state,
    world: {
      item: (id) =>
        ROWS[id] === undefined
          ? undefined
          : ({ id, name: ROWS[id].name, price: ROWS[id].price, currency: 'copper' } as never),
      stockingPlaces: (items) => {
        asked.push([...items]);
        return places.filter((each) => items.includes(each.item));
      }
    },
    kept: () => ({ supplies: ['torch'], sets: ['troll hide'], keys: [], blessWith: [] }),
    outgrown: () => ['scale mail'],
    rarity: (id) => ROWS[id]?.rarity ?? 'unknown',
    traveller: () => ({}),
    quests: { wantedBy: (found) => (found.ids?.[0] === 13 ? 'The Lost Crown' : null) },
    choices: DEFAULT_OUTGROWN,
    ...over
  };
}

const ALL = Object.keys(ROWS).map((id) => place(Number(id), 5, 'Junkyard', 2));

describe('the sale on the way to the bank', () => {
  it('keeps what is worn, keys, supplies, gear sets, tokens, rare and unoutgrown gear', () => {
    const pack = [
      item('rusty dagger'),
      item('bone charm'),
      item('leather cap', { wornSlotCode: 2 }),
      item('iron key', { kind: 'key' }),
      item('torch'),
      item('scale mail', { wornSlotCode: 11 }),
      item('token of Silvermere'),
      item('star sapphire'),
      item('gold idol'),
      item('troll hide'),
      item('wooden cup'),
      item('blessed ankh', { equipped: true })
    ];
    const { sale } = saleOnTheWay(reads(pack, ALL), BANK, [7]);
    // The positive control is the sale itself: the dagger, the charm and the outgrown mail go.
    expect(sale?.items.sort()).toEqual(['bone charm', 'rusty dagger', 'scale mail']);
    // Half the realm's price at charm 50.
    expect(sale?.copper).toBe(1000 + 1500 + 1000);
    expect(sale?.shop).toBe('Junkyard');
  });

  it('sells a rare stone too with Keep Rare Gear off', () => {
    const pack = [item('rusty dagger'), item('star sapphire')];
    const off = { choices: { ...DEFAULT_OUTGROWN, keepRare: false } };
    // Positive control: the same pack keeps the sapphire at the shipped switch.
    expect(saleOnTheWay(reads(pack, ALL), BANK, []).sale?.items).toEqual(['rusty dagger']);
    const { sale } = saleOnTheWay(reads(pack, ALL, off), BANK, []);
    expect(sale?.items.sort()).toEqual(['rusty dagger', 'star sapphire']);
  });

  it('keeps an item a quest still needs, and says which quest', () => {
    const choice = saleOnTheWay(reads([item('rusty dagger'), item('old map')], ALL), BANK, []);
    expect(choice.sale?.items).toEqual(['rusty dagger']);
    expect(choice.questKept).toEqual([{ item: 'old map', quest: 'The Lost Crown' }]);
  });

  it('drops a counter past the detour the run allows', () => {
    const far = DEFAULT_OUTGROWN.sellDetour + 1;
    const fake = reads([item('rusty dagger')], [place(1, 9, 'Far Smithy', far)]);
    const choice = saleOnTheWay(fake, BANK, []);
    // Positive control: the counter was asked for and found.
    expect(fake.asked).toEqual([[1]]);
    expect(choice.sale).toBeNull();
  });

  // The case above drops the same counter at the shipped detour: the positive control.
  it('stops at it where the outgrown block allows the longer detour', () => {
    const far = DEFAULT_OUTGROWN.sellDetour + 1;
    const choices = { ...DEFAULT_OUTGROWN, sellDetour: far };
    const fake = reads([item('rusty dagger')], [place(1, 9, 'Far Smithy', far)], { choices });
    expect(saleOnTheWay(fake, BANK, []).sale?.shop).toBe('Far Smithy');
  });

  it('picks the counter that pays most, and the shorter detour on a tie', () => {
    const pack = [item('rusty dagger'), item('bone charm')];
    const pays = [
      place(1, 3, 'Pawnshop', 1),
      place(1, 4, 'Junkyard', 3),
      place(2, 4, 'Junkyard', 3)
    ];
    expect(saleOnTheWay(reads(pack, pays), BANK, []).sale?.shop).toBe('Junkyard');
    const tie = [place(1, 3, 'Pawnshop', 4), place(1, 4, 'Junkyard', 2)];
    const one = saleOnTheWay(reads([item('rusty dagger')], tie), BANK, []).sale;
    expect(one).toEqual({ room: '1/4', shop: 'Junkyard', items: ['rusty dagger'], copper: 1000 });
  });

  it('sells no item whose name several rows share', () => {
    const pack = [item('rusty dagger'), item('bone charm', { ids: [2, 3] })];
    // Positive control: the dagger beside it sells.
    expect(saleOnTheWay(reads(pack, ALL), BANK, []).sale?.items).toEqual(['rusty dagger']);
  });

  it('asks for no counter when nothing carried is for sale', () => {
    const fake = reads([item('torch')], ALL);
    expect(saleOnTheWay(fake, BANK, [])).toEqual({ sale: null, questKept: [] });
    expect(fake.asked).toEqual([]);
  });
});
