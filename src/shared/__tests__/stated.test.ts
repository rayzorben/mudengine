import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../character';
import { readStatAll, statedBasis, statedNow } from '../stated';

/** The rows `user-stat-all` builds from the user's own sheet (2026-09-18). */
const ROWS: Array<Record<string, string>> = [
  { healthRegen: '6', restingRegen: '18' },
  { baseManaRegen: '3', manaRegen: '4' },
  { section: 'Attacks' },
  { swings: '3.584', accuracy: '105', min: '8', max: '25' },
  { section: 'Spells' }
];

/** A character with the sheet, the pack and one buff read. */
const STATE: CharacterState = {
  ...EMPTY_CHARACTER,
  name: 'Festus',
  className: 'Paladin',
  progress: {
    ...EMPTY_CHARACTER.progress,
    level: 12,
    strength: 70,
    agility: 60,
    intellect: 50,
    willpower: 55,
    health: 65,
    charm: 50
  },
  inventory: {
    ...EMPTY_CHARACTER.inventory,
    encumbrance: 400,
    encumbranceMax: 2000,
    items: [
      { name: 'mace', source: 'wire', slot: 'Weapon Hand', equipped: true, charges: null },
      {
        name: 'torch',
        source: 'wire',
        slot: 'Readied',
        equipped: true,
        charges: 79,
        kind: 'light'
      }
    ]
  },
  buffs: [{ spell: 'bless', by: null, appliedAt: 0 }]
};

const sheetOf = (state: CharacterState): CharacterState => ({
  ...state,
  stated: readStatAll(ROWS, statedBasis(state))
});

describe('reading stat all', () => {
  it('keeps each figure something reads, in the server’s words', () => {
    expect(readStatAll(ROWS, statedBasis(STATE))).toMatchObject({
      against: null,
      healthRegen: 6,
      restingRegen: 18,
      baseManaRegen: 3,
      manaRegen: 4,
      round: { swings: 3.584, accuracy: 105, min: 8, max: 25 }
    });
  });

  it('names the monster a sheet was run against', () => {
    const rows = ROWS.map((row) =>
      row['section'] === 'Attacks' ? { ...row, against: 'black orc captain' } : row
    );
    expect(readStatAll(rows, statedBasis(STATE))?.against).toBe('black orc captain');
  });

  it('reads no round out of the spell table', () => {
    const rows: Array<Record<string, string>> = [
      { healthRegen: '6', restingRegen: '18' },
      { section: 'Spells' },
      { swings: '1', accuracy: '100', min: '5', max: '9' }
    ];
    expect(readStatAll(rows, statedBasis(STATE))?.round).toBeNull();
  });

  it('answers nothing for a sheet with nothing on it', () => {
    expect(readStatAll([{ section: 'Attacks' }], statedBasis(STATE))).toBeNull();
  });
});

describe('what of a sheet still holds', () => {
  it('holds every figure while nothing it was computed from has moved', () => {
    expect(statedNow(sheetOf(STATE))).toEqual({
      accuracy: 105,
      swings: 3.584,
      health: 6,
      resting: 18,
      mana: 4,
      meditating: 3,
      damage: { min: 8, max: 25 }
    });
  });

  /* A readied torch burning out moves no figure — `wieldedWeapon`'s rule. */
  it('holds across a light going out', () => {
    const read = sheetOf(STATE);
    const dark = {
      ...read,
      inventory: {
        ...read.inventory,
        items: read.inventory.items.map((item) =>
          item.kind === 'light' ? { ...item, equipped: false } : item
        )
      }
    };
    expect(statedNow(dark)?.accuracy).toBe(105);
  });

  /* `Player.cs`: a KaiBound Mystic's `MARegen` is `-1`, a sentinel and not a rate. */
  it('states no mana rate from the KaiBind sentinel', () => {
    const read = sheetOf(STATE);
    const bound = { ...read, stated: { ...read.stated!, manaRegen: -1 } };
    expect(statedNow(bound)).not.toHaveProperty('mana');
    expect(statedNow(bound)?.meditating).toBe(3);
  });

  it('drops everything when the gear, the level or an effect moves', () => {
    const read = sheetOf(STATE);
    const unarmed: CharacterState = {
      ...read,
      inventory: {
        ...read.inventory,
        items: read.inventory.items.map((item) => ({ ...item, equipped: false }))
      }
    };
    expect(statedNow(unarmed)).toBeNull();
    expect(statedNow({ ...read, progress: { ...read.progress, level: 13 } })).toBeNull();
    expect(statedNow({ ...read, buffs: [] })).toBeNull();
  });

  /*
   * The pack's share moves accuracy and swings (`CalcAccuracy`,
   * `CalcEnergyUsedWithEncum`) and nothing else that is read.
   */
  it('keeps the regeneration and the range when only the load moves', () => {
    const read = sheetOf(STATE);
    const heavier = { ...read, inventory: { ...read.inventory, encumbrance: 900 } };
    expect(statedNow(heavier)).toEqual({
      health: 6,
      resting: 18,
      mana: 4,
      meditating: 3,
      damage: { min: 8, max: 25 }
    });
  });

  it('takes no range from a sheet run against a monster', () => {
    const read = sheetOf(STATE);
    const against = { ...read, stated: { ...read.stated!, against: 'black orc captain' } };
    expect(statedNow(against)).not.toHaveProperty('damage');
    expect(statedNow(against)?.accuracy).toBe(105);
  });

  it('is nothing before a sheet is read', () => {
    expect(statedNow(STATE)).toBeNull();
  });
});
