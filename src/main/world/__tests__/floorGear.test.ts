import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { ItemEntity } from '../../../shared/entities';
import { UNKNOWN_WEARER } from '../../../shared/gear';
import type { ProwessSheet } from '../../../shared/prowess';
import type { WorldItem } from '../../../shared/world';
import { floorGear, type FloorRealm } from '../floorGear';

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

const piece = (id: number, name: string, worn: number, ac: number, enc = 50): WorldItem =>
  ({ id, name, worn, kind: 'armour', armour: { ac }, encumbrance: enc }) as WorldItem;

const ITEMS = [
  piece(1, 'sandals', 5, 10),
  piece(3, 'leather boots', 5, 20),
  piece(4, 'iron ring', 4, 1),
  piece(5, 'silver ring', 4, 2),
  piece(6, 'anvil boots', 5, 40, 5000),
  piece(7, 'kite shield', 12, 30),
  {
    id: 8,
    name: 'greatsword',
    worn: 1,
    kind: 'weapon',
    weapon: { min: 10, max: 30, hands: 2 },
    encumbrance: 100
  } as WorldItem
];

const realm: FloorRealm = { item: (id) => ITEMS.find((item) => item.id === id) };
const askerOf = () => ({
  wearer: UNKNOWN_WEARER,
  sheet: SHEET,
  family: 'greatermud' as const,
  attack: 'a'
});

const row = (id: number, over: Partial<ItemEntity> = {}): ItemEntity => {
  const item = ITEMS.find((each) => each.id === id)!;
  return {
    source: 'world',
    slot: null,
    charges: null,
    equipped: false,
    name: item.name,
    id,
    wornSlotCode: item.worn,
    ...(item.armour === undefined ? {} : { armour: item.armour }),
    ...(item.weapon === undefined ? {} : { weapon: item.weapon }),
    ...over
  } as ItemEntity;
};

function wearing(
  items: ItemEntity[],
  weight: [number, number] | null = [100, 2000]
): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    inventory: {
      ...base.inventory,
      items,
      encumbrance: weight?.[0] ?? null,
      encumbranceMax: weight?.[1] ?? null
    }
  };
}

describe('gear on the floor against what is worn', () => {
  it('is better where it outranks the worn item in its slot', () => {
    const state = wearing([row(1, { equipped: true, slot: 'Feet' })]);
    expect(floorGear(row(3), state, realm, askerOf, [])).toEqual({
      kind: 'better',
      slot: 'Feet',
      over: 'sandals',
      replaces: null,
      hands: null
    });
  });

  it('is nothing where it is no better than what is worn', () => {
    const state = wearing([row(3, { equipped: true, slot: 'Feet' })]);
    expect(floorGear(row(1), state, realm, askerOf, [])).toBeNull();
  });

  it('fills an empty place, and names the weakest ring where both fingers are full', () => {
    const one = wearing([row(5, { equipped: true, slot: 'Finger' })]);
    expect(floorGear(row(4), one, realm, askerOf, [])).toMatchObject({
      kind: 'better',
      over: null
    });
    const both = wearing([
      row(4, { equipped: true, slot: 'Finger' }),
      row(4, { equipped: true, slot: 'Finger', name: 'iron ring' })
    ]);
    expect(floorGear(row(5), both, realm, askerOf, [])).toMatchObject({
      kind: 'better',
      over: 'iron ring',
      replaces: 'iron ring'
    });
  });

  it('is nothing where one is already carried unworn', () => {
    const state = wearing([row(1, { equipped: true, slot: 'Feet' }), row(3)]);
    expect(floorGear(row(3), state, realm, askerOf, [])).toBeNull();
  });

  it('is refused where the pack has not the free weight, or its weight is unread', () => {
    const worn = [row(1, { equipped: true, slot: 'Feet' })];
    expect(floorGear(row(6), wearing(worn), realm, askerOf, [])).toMatchObject({ why: 'heavy' });
    expect(floorGear(row(3), wearing(worn, null), realm, askerOf, [])).toMatchObject({
      why: 'unread'
    });
  });

  it('is refused where a gear set names what it would replace', () => {
    const state = wearing([row(1, { equipped: true, slot: 'Feet' })]);
    expect(floorGear(row(3), state, realm, askerOf, ['sandals'])).toEqual({
      kind: 'refused',
      slot: 'Feet',
      why: 'kit',
      worn: 'sandals'
    });
  });

  it('is refused where a two-handed weapon and the off-hand would meet', () => {
    const shield = wearing([row(7, { equipped: true, slot: 'Off-Hand' })]);
    expect(floorGear(row(8), shield, realm, askerOf, [])).toMatchObject({
      why: 'hands',
      worn: 'kite shield'
    });
    const sword = wearing([row(8, { equipped: true, slot: 'Weapon Hand' })]);
    expect(floorGear(row(7), sword, realm, askerOf, [])).toMatchObject({
      why: 'hands',
      worn: 'greatsword'
    });
  });

  it('is refused in a slot a death holds, unless it is the item died in', () => {
    const state = {
      ...wearing([row(1, { equipped: true, slot: 'Feet' })]),
      loadout: [{ slot: 'Feet', item: 'leather boots', at: 1, locked: { at: 1, played: 0 } }]
    };
    // Heavy as well: the hold is said first, being the reason it never goes on.
    expect(floorGear(row(6), state, realm, askerOf, [])).toEqual({
      kind: 'refused',
      slot: 'Feet',
      why: 'locked',
      worn: 'leather boots'
    });
    expect(floorGear(row(3), state, realm, askerOf, [])).toMatchObject({ kind: 'better' });
  });

  it('is nothing for a name several rows share', () => {
    const state = wearing([row(1, { equipped: true, slot: 'Feet' })]);
    const shared = row(3, { id: undefined, ids: [3, 6] });
    expect(floorGear(shared, state, realm, askerOf, [])).toBeNull();
  });
});
