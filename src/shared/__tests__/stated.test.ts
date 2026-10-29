import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../character';
import {
  keepSheet,
  readStatAll,
  STATED_SHEETS_KEPT,
  statedAgainst,
  statedBasis,
  statedNow,
  type StatedSheet
} from '../stated';

/** The rows `user-stat-all` builds from the user's own sheet (2026-09-18). */
const ROWS: Array<Record<string, string>> = [
  { healthRegen: '6', restingRegen: '18', versusEvil: '68' },
  { baseManaRegen: '3', manaRegen: '4' },
  { versusGood: '58' },
  { section: 'Attacks' },
  {
    attack: 'Attack',
    swings: '3.584',
    accuracy: '105',
    min: '8',
    max: '25',
    crits: '3',
    perRound: '65',
    withExtra: '67'
  },
  {
    attack: 'Bash',
    swings: '1.792',
    accuracy: '105',
    min: '22',
    max: '82',
    perRound: '93',
    withExtra: '94'
  },
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

const sheetAt = (state: CharacterState): StatedSheet => readStatAll(ROWS, statedBasis(state))!;

const sheetOf = (state: CharacterState): CharacterState => ({
  ...state,
  stated: keepSheet(state.stated, sheetAt(state))
});

describe('reading stat all', () => {
  it('keeps each figure something reads, in the server’s words', () => {
    expect(readStatAll(ROWS, statedBasis(STATE))).toMatchObject({
      against: null,
      healthRegen: 6,
      restingRegen: 18,
      baseManaRegen: 3,
      manaRegen: 4,
      versusEvil: 68,
      versusGood: 58,
      rounds: {
        // The round with the hit spells, where the sheet brackets one.
        attack: { swings: 3.584, accuracy: 105, min: 8, max: 25, crits: 3, perRound: 67 },
        bash: { swings: 1.792, accuracy: 105, min: 22, max: 82, crits: null, perRound: 94 }
      }
    });
  });

  it('names the monster a sheet was run against', () => {
    const rows = ROWS.map((row) =>
      row['section'] === 'Attacks' ? { ...row, against: 'black orc captain' } : row
    );
    const sheet = readStatAll(rows, statedBasis(STATE));
    expect(sheet?.against).toBe('black orc captain');
    // There the column is the share of every swing that crits, not the attack's crits.
    expect(sheet?.rounds.attack?.crits).toBeNull();
  });

  it('reads no round out of the spell table', () => {
    const rows: Array<Record<string, string>> = [
      { healthRegen: '6', restingRegen: '18' },
      { section: 'Spells' },
      { attack: 'Attack', swings: '1', accuracy: '100', min: '5', max: '9', perRound: '7' }
    ];
    expect(readStatAll(rows, statedBasis(STATE))?.rounds).toEqual({});
  });

  it('answers nothing for a sheet with nothing on it', () => {
    expect(readStatAll([{ section: 'Attacks' }], statedBasis(STATE))).toBeNull();
  });
});

describe('what of a sheet still holds', () => {
  it('holds every figure while nothing it was computed from has moved', () => {
    expect(statedNow(sheetOf(STATE))).toEqual({
      health: 6,
      resting: 18,
      mana: 4,
      meditating: 3,
      versusEvil: 68,
      versusGood: 58,
      attacks: {
        attack: { accuracy: 105, swings: 3.584, damage: { min: 8, max: 25 }, crits: 3 },
        bash: { accuracy: 105, swings: 1.792, damage: { min: 22, max: 82 } }
      }
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
    expect(statedNow(dark)?.attacks?.attack?.accuracy).toBe(105);
  });

  /* `Player.cs`: a KaiBound Mystic's `MARegen` is `-1`, a sentinel and not a rate. */
  it('states no mana rate from the KaiBind sentinel', () => {
    const read = sheetOf(STATE);
    const bound = { ...read, stated: [{ ...read.stated![0]!, manaRegen: -1 }] };
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
   * The pack's share moves accuracy, swings and the crits quick-and-deadly
   * adds (`CalcAccuracy`, `CalcEnergyUsedWithEncum`) and nothing else that is
   * read.
   */
  it('keeps the regeneration and the range when only the load moves', () => {
    const read = sheetOf(STATE);
    const heavier = { ...read, inventory: { ...read.inventory, encumbrance: 900 } };
    expect(statedNow(heavier)).toEqual({
      health: 6,
      resting: 18,
      mana: 4,
      meditating: 3,
      attacks: {
        attack: { damage: { min: 8, max: 25 } },
        bash: { damage: { min: 22, max: 82 } }
      }
    });
  });

  it('takes nothing from a sheet run against a monster', () => {
    const against = { ...STATE, stated: [{ ...sheetAt(STATE), against: 'black orc captain' }] };
    expect(statedNow(against)).toBeNull();
  });

  /* `stat all <id>` used to replace the character's own sheet and lose its range. */
  it('keeps the own sheet beside one run against a monster', () => {
    const read = sheetOf(STATE);
    const both = {
      ...read,
      stated: keepSheet(read.stated, { ...sheetAt(STATE), against: 'black orc captain' })
    };
    expect(both.stated).toHaveLength(2);
    expect(statedNow(both)?.attacks?.attack?.damage).toEqual({ min: 8, max: 25 });
  });

  /* A loop's blessings come round in the same few sets (todo 45). */
  it('finds the sheet again when an effect it was computed with comes back', () => {
    const blessed = sheetOf(STATE);
    const bare = sheetOf({ ...blessed, buffs: [] });
    expect(bare.stated).toHaveLength(2);
    expect(statedNow({ ...bare, buffs: STATE.buffs })?.health).toBe(6);
  });

  it('is nothing before a sheet is read', () => {
    expect(statedNow(STATE)).toBeNull();
  });
});

describe('keeping sheets', () => {
  it('replaces the sheet for the same basis, newest first', () => {
    const first = sheetAt(STATE);
    const again = { ...first, healthRegen: 7 };
    expect(keepSheet(keepSheet(null, first), again)).toEqual([again]);
  });

  it('keeps at most STATED_SHEETS_KEPT, dropping the oldest', () => {
    let sheets: readonly StatedSheet[] | null = null;
    for (let level = 1; level <= STATED_SHEETS_KEPT + 1; level += 1) {
      const state = { ...STATE, progress: { ...STATE.progress, level } };
      sheets = keepSheet(sheets, sheetAt(state));
    }
    expect(sheets).toHaveLength(STATED_SHEETS_KEPT);
    const levelOne = statedBasis({ ...STATE, progress: { ...STATE.progress, level: 1 } }).gear;
    expect(sheets!.some((sheet) => sheet.basis.gear === levelOne)).toBe(false);
  });

  /* Todo 2322-01: Festus's `st a <n>` readings, kept to check the client's round against. */
  it('keeps sheets run against monsters apart, so they never displace the own', () => {
    let sheets = keepSheet(null, sheetAt(STATE));
    for (let at = 0; at <= STATED_SHEETS_KEPT; at += 1) {
      sheets = keepSheet(sheets, { ...sheetAt(STATE), against: `monster ${at}` });
    }
    expect(sheets!.filter((sheet) => sheet.against === null)).toHaveLength(1);
    expect(sheets!.filter((sheet) => sheet.against !== null)).toHaveLength(STATED_SHEETS_KEPT);
    expect(sheets!.some((sheet) => sheet.against === 'monster 0')).toBe(false);
  });
});

describe('the server’s round against a monster', () => {
  const ran = (state: CharacterState, against: string): CharacterState => ({
    ...state,
    stated: keepSheet(state.stated, { ...sheetAt(state), against })
  });

  it('is the sheet’s Avg/Rnd while the basis holds, by the realm’s name inside the room’s', () => {
    const read = ran(STATE, 'lashworm');
    expect(statedAgainst(read, 'large lashworm', 'bash')).toBe(94);
    expect(statedAgainst(read, 'Lashworm', 'attack')).toBe(67);
    expect(statedAgainst(read, 'worm', 'attack')).toBeNull();
    expect(statedAgainst(read, 'giant', 'attack')).toBeNull();
    // A name in the middle of a longer one is another monster (`mobNameCandidates`).
    expect(statedAgainst(ran(STATE, 'giant rat'), 'big giant rat queen', 'attack')).toBeNull();
  });

  it('takes the whole name over a shorter one when both were run', () => {
    const both = ran(ran(STATE, 'lashworm'), 'large lashworm');
    const large = {
      ...both,
      stated: both.stated!.map((sheet) =>
        sheet.against === 'large lashworm'
          ? {
              ...sheet,
              rounds: { ...sheet.rounds, attack: { ...sheet.rounds.attack!, perRound: 99 } }
            }
          : sheet
      )
    };
    expect(statedAgainst(large, 'large lashworm', 'attack')).toBe(99);
    expect(statedAgainst(large, 'small lashworm', 'attack')).toBe(67);
  });

  it('is nothing once the load or the gear moved', () => {
    const read = ran(STATE, 'lashworm');
    const heavier = { ...read, inventory: { ...read.inventory, encumbrance: 1900 } };
    expect(statedAgainst(heavier, 'lashworm', 'attack')).toBeNull();
    expect(statedAgainst({ ...read, buffs: [] }, 'lashworm', 'attack')).toBeNull();
  });
});
