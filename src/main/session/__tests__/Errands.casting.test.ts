import { describe, expect, it } from 'vitest';

import { Errands, type ErrandsParts, type ErrandsSession } from '../Errands';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { ProwessSheet } from '../../../shared/prowess';
import type { WorldSpell } from '../../../shared/world';

const MISSILE: WorldSpell = {
  id: 1,
  name: 'magic missile',
  short: 'mmis',
  level: 1,
  mana: 1,
  energy: 500,
  targets: 8,
  power: [6, 15]
};
const BLUR: WorldSpell = { id: 2, name: 'blur', short: 'blur', level: 1, mana: 4, targets: 1 };

const STATE: CharacterState = {
  ...EMPTY_CHARACTER,
  progress: { ...EMPTY_CHARACTER.progress, level: 4 },
  vitals: { ...EMPTY_CHARACTER.vitals, mana: 40, manaMax: 40, manaType: 'MA' },
  spellbook: [
    { name: 'magic missile', short: 'mmis', level: 1, cost: 1 },
    { name: 'blur', short: 'blur', level: 1, cost: 4 }
  ]
};

const SHEET = { level: 4, spellcasting: 69 } as unknown as ProwessSheet;

function errands(spells: Partial<AutomationConfig['spells']>): Errands {
  const config: AutomationConfig = {
    ...DEFAULT_CONFIG.automation,
    spells: { ...DEFAULT_CONFIG.automation.spells, ...spells }
  };
  const world = {
    spellNamed: (name: string) =>
      [MISSILE, BLUR].find((spell) => spell.name === name || spell.short === name) ?? null,
    classNamed: () => null
  };
  return new Errands(
    {
      world,
      tracker: { current: STATE },
      fightRecord: {},
      lore: {}
    } as unknown as ErrandsParts,
    { config: () => config, family: () => 'greatermud' } as unknown as ErrandsSession
  );
}

/*
 * The round spell the survey and the fight run price is the one `AttackSpells`
 * casts: derived from the whole book under Auto Choose Best Spell, else the
 * one typed in `spells.attack` (2026-10-05: a typed spell was charged its
 * mana and priced as melee).
 */
describe('the spell a round is priced on', () => {
  it('is the whole book under Auto Choose Best Spell', () => {
    const input = errands({ autoChoose: true, attack: 'blur' }).castingInput(
      STATE,
      SHEET,
      'greatermud'
    );
    expect(input?.book.map((spell) => spell.name)).toEqual(['magic missile', 'blur']);
  });

  it('is the book’s entry for the spell typed, with Auto Choose off', () => {
    const input = errands({ autoChoose: false, attack: 'mmis' }).castingInput(
      STATE,
      SHEET,
      'greatermud'
    );
    expect(input?.book.map((spell) => spell.name)).toEqual(['magic missile']);
  });

  it('is nothing with Auto Choose off and no spell typed, or one the book lacks', () => {
    expect(
      errands({ autoChoose: false, attack: '' }).castingInput(STATE, SHEET, 'greatermud')
    ).toBeNull();
    expect(
      errands({ autoChoose: false, attack: 'fireball' }).castingInput(STATE, SHEET, 'greatermud')
    ).toBeNull();
  });
});
