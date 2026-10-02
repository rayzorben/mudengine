import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { ItemEntity } from '../../../shared/entities';
import { UNKNOWN_WEARER } from '../../../shared/gear';
import type { ProwessSheet } from '../../../shared/prowess';
import type { BuyingPlace, WorldItem } from '../../../shared/world';
import { bestInSlot } from '../bestInSlot';
import { gearUpgrades, type UpgradeRealm } from '../gearUpgrades';
import { wearing as wearingItems } from '../wearing';

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
/* 2026-10-01: Soul bought sandals and cloth shoes in turn, two leather belts, and a ring it never wore. */
describe('what counts as an upgrade', () => {
  it('is not an item only as good as the worn one', () => {
    const state = wearing({ name: 'padded helm', equipped: true, wornSlotCode: 2 });
    const twin = helm(4, 'felt helm', 2);
    const head = gearUpgrades(
      state,
      { ...realm(), itemsWornIn: (worn) => [...ITEMS, twin].filter((item) => item.worn === worn) },
      asker,
      3
    ).find((slot) => slot.slot === 'Head');
    expect(head?.offers.map((offer) => offer.name)).not.toContain('felt helm');
  });

  it('is never something the pack already holds', () => {
    const state = wearing(
      { name: 'leather cap', equipped: true, wornSlotCode: 2 },
      { name: 'padded helm', equipped: false }
    );
    const head = gearUpgrades(state, realm(), asker, 3).find((slot) => slot.slot === 'Head');
    expect(head?.offers.map((offer) => offer.name)).not.toContain('padded helm');
  });

  it('weighs a worn weapon the list does not rank by its blow', () => {
    const weapon = (id: number, name: string, min: number, max: number): WorldItem =>
      ({
        id,
        name,
        worn: 1,
        kind: 'weapon',
        weapon: { min, max, kind: 0, speed: 1000 }
      }) as WorldItem;
    const arms = [weapon(21, 'club', 1, 4), weapon(22, 'mace', 3, 9)];
    const armRealm = {
      ...realm(),
      itemsWornIn: (worn: number) => arms.filter((item) => item.worn === worn)
    };
    const state = wearing({
      name: 'odd stick',
      equipped: true,
      wornSlotCode: 1,
      weapon: { min: 2, max: 6 } as ItemEntity['weapon']
    });
    const hand = gearUpgrades(state, armRealm, asker, 3).find(
      (slot) => slot.slot === 'Weapon Hand'
    );
    expect(hand?.offers.map((offer) => offer.name)).toEqual(['mace']);
  });

  it('is anything for a slot with room for one more, and else better than the weakest worn', () => {
    const ring = (id: number, name: string, ac: number): WorldItem =>
      ({ id, name, worn: 4, kind: 'armour', armour: { ac } }) as WorldItem;
    const rings = [
      ring(11, 'copper ring', 2),
      ring(12, 'silver ring', 3),
      ring(13, 'gold ring', 5)
    ];
    const ringRealm = {
      ...realm(),
      itemsWornIn: (worn: number) => rings.filter((item) => item.worn === worn)
    };
    const fingers = (state: CharacterState) =>
      gearUpgrades(state, ringRealm, asker, 3).find((slot) => slot.slot === 'Finger');
    const one = wearing({ name: 'silver ring', equipped: true, wornSlotCode: 4 });
    expect(fingers(one)?.offers.map((offer) => offer.name)).toEqual(
      expect.arrayContaining(['gold ring', 'silver ring', 'copper ring'])
    );
    const two = wearing(
      { name: 'silver ring', equipped: true, wornSlotCode: 4 },
      { name: 'copper ring', equipped: true, wornSlotCode: 4 }
    );
    expect(fingers(two)?.worn).toBe('copper ring');
    expect(fingers(two)?.offers.map((offer) => offer.name)).toEqual(['gold ring', 'silver ring']);
  });
});

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

describe('the best a slot takes from anywhere', () => {
  const drops = (item: string) => (item === 'iron helm' ? ['cave troll'] : []);

  it('lists what is better than the worn item, sold or dropped, with where it comes from', () => {
    const state = wearing({ name: 'leather cap', equipped: true, wornSlotCode: 2 });
    const head = bestInSlot(state, { ...realm(), dropsOf: drops }, asker, 3).find(
      (slot) => slot.slot === 'Head'
    );
    expect(
      head?.items.map((item) => [item.name, item.sold?.copper ?? null, item.droppedBy])
    ).toEqual([
      ['iron helm', null, ['cave troll']],
      ['padded helm', 400, []]
    ]);
  });

  it('leaves out what the level cannot wear yet', () => {
    const level = (row: WorldItem) => (row.name === 'iron helm' ? { ...row, minLevel: 30 } : row);
    const gated = { ...realm(), dropsOf: drops };
    const rows = ITEMS.map(level);
    gated.itemsWornIn = (worn) => rows.filter((item) => item.worn === worn);
    const base = wearing({ name: 'leather cap', equipped: true, wornSlotCode: 2 });
    const state = { ...base, progress: { ...base.progress, level: 20 } };
    const head = bestInSlot(state, gated, asker, 3).find((slot) => slot.slot === 'Head');
    expect(head?.items.map((item) => item.name)).toEqual(['padded helm']);
  });
});

describe('the character wearing other gear', () => {
  const entity = (name: string): ItemEntity => {
    const row = ITEMS.find((item) => item.name === name);
    return {
      name,
      source: 'realm',
      slot: null,
      equipped: false,
      charges: null,
      ...(row === undefined
        ? {}
        : { id: row.id, wornSlotCode: row.worn, armour: row.armour, encumbrance: 5 })
    } as unknown as ItemEntity;
  };
  const gear = { itemsWornIn: realm().itemsWornIn, buildItemEntity: entity };

  it('puts the item on over the worn one and moves the sheet by the difference at its scale', () => {
    const base = wearing({
      name: 'leather cap',
      equipped: true,
      wornSlotCode: 2,
      armour: { ac: 10 }
    });
    const state = {
      ...base,
      progress: { ...base.progress, armourClass: 3, damageResist: 0 },
      inventory: { ...base.inventory, encumbrance: 100 }
    };
    const { state: after, worn } = wearingItems(state, ['iron helm'], gear, asker);
    expect(worn).toEqual(['iron helm']);
    // Both read from the slot's rows, as the rankings read them: the cap's row
    // states ac 1 whatever the pack's copy says, the iron helm 6: (6 - 1) / 10.
    expect(after.progress.armourClass).toBeCloseTo(3.5);
    expect(after.inventory.encumbrance).toBe(105);
    expect(after.inventory.items.map((item) => [item.name, item.equipped])).toEqual([
      ['leather cap', false],
      ['iron helm', true]
    ]);
  });

  it('changes nothing for a name the realm does not hold', () => {
    const state = wearing({ name: 'leather cap', equipped: true, wornSlotCode: 2 });
    expect(wearingItems(state, ['glass jug'], gear, asker)).toEqual({ state, worn: [] });
  });

  it('puts on a copy the pack already carries, adding no weight', () => {
    const base = wearing(
      { name: 'leather cap', equipped: true, wornSlotCode: 2 },
      { name: 'iron helm', equipped: false, wornSlotCode: 2 }
    );
    const state = { ...base, inventory: { ...base.inventory, encumbrance: 100 } };
    const { state: after } = wearingItems(state, ['iron helm'], gear, asker);
    expect(after.inventory.encumbrance).toBe(100);
    expect(after.inventory.items.map((item) => [item.name, item.equipped])).toEqual([
      ['leather cap', false],
      ['iron helm', true]
    ]);
  });

  it('keeps the armour class known when an item with no armour comes off', () => {
    const base = wearing({ name: 'leather cap', equipped: true, wornSlotCode: 2, id: 1 });
    const state = { ...base, progress: { ...base.progress, armourClass: 3, damageResist: 0 } };
    const bare = {
      ...gear,
      itemsWornIn: () =>
        [helm(1, 'leather cap', 0), helm(3, 'iron helm', 6)].map((row) =>
          row.id === 1 ? { ...row, armour: undefined } : row
        ) as WorldItem[]
    };
    const { state: after } = wearingItems(state, ['iron helm'], bare, asker);
    expect(after.progress.armourClass).toBeCloseTo(3.6);
  });
});
