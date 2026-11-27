import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { DEFAULT_CONFIG } from '../../../shared/config';
import type { ItemEntity } from '../../../shared/entities';
import { UNKNOWN_WEARER, type Wearer } from '../../../shared/gear';
import type { ProwessSheet } from '../../../shared/prowess';
import type { WorldItem } from '../../../shared/world';
import type { FloorRealm } from '../floorGear';
import type { SlotAsker } from '../slotGear';
import { wornBeside } from '../wornBeside';

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
  piece(7, 'kite shield', 12, 30),
  { ...piece(9, 'elven boots', 5, 30), minLevel: 50 } as WorldItem,
  {
    id: 8,
    name: 'greatsword',
    worn: 1,
    kind: 'weapon',
    weapon: { min: 10, max: 30, hands: 2 },
    encumbrance: 100
  } as WorldItem,
  { id: 10, name: 'lantern', kind: 'light' } as WorldItem
];

const byId = (id: number): WorldItem => ITEMS.find((item) => item.id === id)!;
const realm: FloorRealm = { item: (id) => ITEMS.find((item) => item.id === id) };

const asker = (wearer: Wearer = UNKNOWN_WEARER): SlotAsker => ({
  wearer,
  sheet: SHEET,
  family: 'greatermud',
  attack: 'a',
  weighing: { weights: DEFAULT_CONFIG.automation.loot.gearWeights, casts: false, sneaks: false }
});

const worn = (id: number, slot: string): ItemEntity => {
  const item = byId(id);
  return {
    source: 'hybrid',
    slot,
    charges: null,
    equipped: true,
    name: item.name,
    id,
    wornSlotCode: item.worn,
    ...(item.armour === undefined ? {} : { armour: item.armour }),
    ...(item.encumbrance === undefined ? {} : { encumbrance: item.encumbrance })
  } as ItemEntity;
};

function wearing(items: ItemEntity[], listed = true): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    inventory: { ...base.inventory, items, listedAt: listed ? 1 : null }
  };
}

describe('an item looked up beside what is worn', () => {
  it('sets the item against the piece it replaces, with each side figures', () => {
    const beside = wornBeside(byId(3), wearing([worn(1, 'Feet')]), realm, asker());
    expect(beside).toMatchObject({
      slot: 'Feet',
      replaces: 'sandals',
      verdict: 'better',
      handsFree: null,
      item: { name: 'leather boots', ac: 20, weight: 50 },
      worn: [{ name: 'sandals', weight: 50 }]
    });
    expect(beside?.worn?.[0]?.figures.ac).toBe(10);
  });

  it('says worse where the worn piece outranks it', () => {
    const beside = wornBeside(byId(1), wearing([worn(3, 'Feet')]), realm, asker());
    expect(beside).toMatchObject({ replaces: 'leather boots', verdict: 'worse' });
  });

  it('replaces nothing where a place in the slot is free', () => {
    const beside = wornBeside(byId(4), wearing([worn(5, 'Finger')]), realm, asker());
    expect(beside).toMatchObject({ replaces: null, verdict: null });
    expect(beside?.worn?.map((each) => each.name)).toEqual(['silver ring']);
  });

  it('keeps what is worn unknown until the pack is listed', () => {
    const beside = wornBeside(byId(3), wearing([], false), realm, asker());
    expect(beside).toMatchObject({ worn: null, replaces: null, verdict: null });
  });

  it('names the off-hand piece a two-hander needs off first', () => {
    const beside = wornBeside(byId(8), wearing([worn(7, 'Off-Hand')]), realm, asker());
    expect(beside?.handsFree).toBe('kite shield');
  });

  it('is nothing for what is not worn, what is refused, or the piece worn now', () => {
    const state = wearing([worn(1, 'Feet')]);
    expect(wornBeside(byId(10), state, realm, asker())).toBeNull();
    expect(wornBeside(byId(1), state, realm, asker())).toBeNull();
    const low = { ...UNKNOWN_WEARER, level: 10 };
    expect(wornBeside(byId(9), state, realm, asker(low))).toBeNull();
    const high = { ...UNKNOWN_WEARER, level: 60 };
    expect(wornBeside(byId(9), state, realm, asker(high))).not.toBeNull();
  });
});
