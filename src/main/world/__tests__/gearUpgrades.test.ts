import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { ItemEntity } from '../../../shared/entities';
import { UNKNOWN_WEARER } from '../../../shared/gear';
import type { ProwessSheet } from '../../../shared/prowess';
import type { BuyingPlace, WorldItem } from '../../../shared/world';
import { gearUpgrades, type UpgradeRealm } from '../gearUpgrades';

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

const helm = (id: number, name: string, ac: number): WorldItem =>
  ({ id, name, worn: 2, kind: 'armour', armour: { ac } }) as WorldItem;

const ITEMS = [helm(1, 'leather cap', 1), helm(2, 'padded helm', 2), helm(3, 'iron helm', 6)];

/** Every item but the iron helm is sold at the Armoury; the iron helm drops from a monster. */
function realm(): UpgradeRealm & { asked: number[][] } {
  const asked: number[][] = [];
  return {
    asked,
    itemsWornIn: (worn) => ITEMS.filter((item) => item.worn === worn),
    stockingPlaces: (items) => {
      asked.push([...items]);
      return items
        .filter((item) => item !== 3)
        .map((item): BuyingPlace & { item: number } => ({
          item,
          map: 1,
          room: 9,
          roomName: 'Armoury',
          shop: 'Armoury',
          markup: 0,
          detour: 4,
          moves: 4
        }));
    },
    priceAt: (name) => (name === 'padded helm' ? 400 : 100)
  };
}

function wearing(...items: Array<Partial<ItemEntity>>): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    inventory: {
      ...base.inventory,
      items: items.map(
        (item) => ({ source: 'wire', slot: null, charges: null, ...item }) as ItemEntity
      )
    }
  };
}

const asker = { wearer: UNKNOWN_WEARER, sheet: SHEET, family: 'greatermud' as const, attack: 'a' };

describe('the better gear the realm sells, per slot', () => {
  it('offers what is better than the worn item and sold at a counter, with its price', () => {
    const state = wearing({ name: 'leather cap', equipped: true, wornSlotCode: 2 });
    const head = gearUpgrades(state, realm(), asker, 3).find((slot) => slot.slot === 'Head');
    expect(head?.worn).toBe('leather cap');
    expect(head?.wornFigure).toBe(1);
    // The iron helm is better and sold nowhere, so it is not something cash can fetch.
    expect(head?.offers.map((offer) => [offer.name, offer.copper, offer.shop])).toEqual([
      ['padded helm', 400, 'Armoury']
    ]);
  });

  it('asks the counters once for every slot together', () => {
    const where = realm();
    gearUpgrades(wearing(), where, asker, 3);
    expect(where.asked).toHaveLength(1);
  });

  it('offers nothing worse than an item the list does not hold', () => {
    const state = wearing({
      name: 'crown of the drake',
      equipped: true,
      wornSlotCode: 2,
      armour: { ac: 5 }
    });
    const head = gearUpgrades(state, realm(), asker, 3).find((slot) => slot.slot === 'Head');
    expect(head?.offers).toEqual([]);
  });
});

/*
 * 2026-10-01: the weapon slot offered a level-10 character a 3.6M and a 3.9M
 * copper weapon, and nothing it could buy.
 */
describe('the cheapest upgrade in each slot', () => {
  const dear = (): UpgradeRealm => ({
    ...realm(),
    stockingPlaces: (items) =>
      items.map((item): BuyingPlace & { item: number } => ({
        item,
        map: 1,
        room: 9,
        roomName: 'Armoury',
        shop: 'Armoury',
        markup: 0,
        detour: 4,
        moves: 4
      })),
    priceAt: (name) => (name === 'leather cap' ? 50 : 900_000)
  });

  it('is offered beside the best, where the best leave it out', () => {
    const state = wearing();
    state.progress.level = 10;
    const head = gearUpgrades(state, dear(), asker, 1).find((slot) => slot.slot === 'Head');
    expect(head?.offers.map((offer) => offer.name)).toEqual(['iron helm', 'leather cap']);
  });

  it('is not offered twice, nor while the level is unread', () => {
    const state = wearing();
    state.progress.level = 10;
    const head = gearUpgrades(state, dear(), asker, 3).find((slot) => slot.slot === 'Head');
    expect(head?.offers.map((offer) => offer.name)).toEqual([
      'iron helm',
      'padded helm',
      'leather cap'
    ]);
    const unread = gearUpgrades(wearing(), dear(), asker, 1).find((slot) => slot.slot === 'Head');
    expect(unread?.offers.map((offer) => offer.name)).toEqual(['iron helm']);
  });
});
