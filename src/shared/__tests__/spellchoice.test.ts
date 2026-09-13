import { describe, expect, it } from 'vitest';

import {
  castsToKill,
  chooseAttackSpell,
  spellElementOf,
  type SpellChoiceInput
} from '../spellchoice';
import type { ProwessSheet } from '../prowess';
import type { WorldSpell } from '../world';

/*
 * The reviewer's worked example (todo 09): a 100 hp monster that resists
 * lightning. The bolt is never cast; the jet is, until what is left is inside
 * the missile's least roll, when the cheaper certain kill wins.
 */
const REALM: Record<string, WorldSpell> = {
  'magic missile': {
    id: 1,
    name: 'magic missile',
    short: 'mmis',
    level: 1,
    mana: 2,
    targets: 8,
    power: [20, 24],
    element: 'normal'
  },
  'lightning bolt': {
    id: 8,
    name: 'lightning bolt',
    short: 'lbol',
    level: 8,
    mana: 3,
    targets: 8,
    power: [40, 60],
    element: 'lightning'
  },
  'fire jet': {
    id: 9,
    name: 'fire jet',
    short: 'fjet',
    level: 6,
    mana: 5,
    targets: 8,
    power: [30, 55],
    element: 'fire'
  },
  shield: { id: 20, name: 'shield', short: 'shld', level: 1, mana: 4, targets: 1, power: [5, 5] }
};

const BOOK = [
  { name: 'magic missile', short: 'mmis', level: 1, cost: 2 },
  { name: 'lightning bolt', short: 'lbol', level: 8, cost: 3 },
  { name: 'fire jet', short: 'fjet', level: 6, cost: 5 },
  { name: 'shield', short: 'shld', level: 1, cost: 4 }
];

/* A sheet with no spellcasting figure: the cast's own odds are then taken as certain. */
const SHEET: ProwessSheet = {
  level: 10,
  agility: null,
  intellect: null,
  charm: null,
  willpower: null,
  health: null,
  strength: null,
  spellcasting: null,
  combatLevel: null,
  mageryLevel: null,
  encumbrancePercent: null
};

const input = (over: Partial<SpellChoiceInput> = {}): SpellChoiceInput => ({
  book: BOOK,
  realm: (name) => REALM[name] ?? null,
  level: 10,
  mana: 50,
  sheet: SHEET,
  family: null,
  target: { remaining: 100, magicRes: null, abilities: [[66, 100]] },
  excluded: new Set(),
  killConfidence: 0.9,
  ...over
});

describe('choosing the round spell', () => {
  it('never casts a spell the target resists, and opens with the hardest hitter it can', () => {
    const choice = chooseAttackSpell(input());
    expect(choice.chosen?.spell.name).toBe('fire jet');
    expect(choice.why).toBe('hardest');
    expect(choice.considered.map((c) => c.spell.name).sort()).toEqual([
      'fire jet',
      'magic missile'
    ]);
  });

  it('switches to the cheapest spell whose least roll finishes what is left', () => {
    const choice = chooseAttackSpell(
      input({ target: { remaining: 13, magicRes: null, abilities: [[66, 100]] } })
    );
    expect(choice.chosen?.spell.name).toBe('magic missile');
    expect(choice.why).toBe('kills');
    expect(choice.chosen?.killChance).toBe(1);
  });

  it('takes a partial resistance off the damage rather than refusing the spell', () => {
    const choice = chooseAttackSpell(
      input({ target: { remaining: 100, magicRes: null, abilities: [[66, 50]] } })
    );
    // The bolt at half: 20–30, under the jet's 30–55.
    const bolt = choice.considered.find((c) => c.spell.name === 'lightning bolt');
    expect(bolt).toMatchObject({ min: 20, max: 30 });
    expect(choice.chosen?.spell.name).toBe('fire jet');
  });

  it('leaves out what the pool cannot pay for, the level cannot cast, and what was refused', () => {
    expect(chooseAttackSpell(input({ mana: 4 })).chosen?.spell.name).toBe('magic missile');
    expect(chooseAttackSpell(input({ level: 5 })).chosen?.spell.name).toBe('magic missile');
    expect(chooseAttackSpell(input({ excluded: new Set(['fire jet']) })).chosen?.spell.name).toBe(
      'magic missile'
    );
  });

  it('says which of five things stopped it, and asks for an unread book', () => {
    expect(chooseAttackSpell({ book: null }).refusal).toBe('no-book');
    expect(chooseAttackSpell(input({ book: [] })).refusal).toBe('empty-book');
    expect(chooseAttackSpell(input({ book: [BOOK[3]!] })).refusal).toBe('no-attack-spells');
    expect(chooseAttackSpell(input({ mana: 1 })).refusal).toBe('no-mana');
    expect(
      chooseAttackSpell(
        input({
          book: [BOOK[1]!],
          target: { remaining: 100, magicRes: null, abilities: [[66, 100]] }
        })
      ).refusal
    ).toBe('all-resisted');
  });

  it('prices a poison spell as all or nothing, as the server does', () => {
    const realm: Record<string, WorldSpell> = {
      venom: {
        id: 30,
        name: 'venom',
        short: 'ven',
        level: 1,
        mana: 2,
        targets: 8,
        power: [10, 20],
        element: 'poison'
      }
    };
    const immune = chooseAttackSpell(
      input({
        book: [{ name: 'venom', short: 'ven', level: 1, cost: 2 }],
        realm: (n) => realm[n] ?? null,
        target: { remaining: 50, magicRes: null, abilities: [[21, 100]] }
      })
    );
    expect(immune.refusal).toBe('all-resisted');
    const partly = chooseAttackSpell(
      input({
        book: [{ name: 'venom', short: 'ven', level: 1, cost: 2 }],
        realm: (n) => realm[n] ?? null,
        target: { remaining: 50, magicRes: null, abilities: [[21, 60]] }
      })
    );
    expect(partly.chosen).toMatchObject({ min: 10, max: 20 });
  });
});

describe('the element column', () => {
  it('reads Spell.GetSpellAttackType’s seven codes and nothing else', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(spellElementOf)).toEqual([
      'cold',
      'fire',
      'stone',
      'lightning',
      'normal',
      'water',
      'poison'
    ]);
    expect(spellElementOf(7)).toBeUndefined();
    expect(spellElementOf(null)).toBeUndefined();
  });
});

/*
 * The caster's rounds for the lair survey (todo 108): a Mage's swing says
 * nothing about how long a fight lasts, so the spell the book would yield
 * against this monster does, one cast a round.
 */
describe('casts to kill', () => {
  const realm = (name: string): WorldSpell | null =>
    name === 'lightning bolt'
      ? {
          id: 8,
          name,
          short: 'lbol',
          level: 8,
          mana: 3,
          targets: 8,
          element: 'lightning',
          power: [12, 20]
        }
      : null;
  const sheet = { level: 10, spellcasting: 65 } as unknown as ProwessSheet;
  const input = {
    book: [{ name: 'lightning bolt', short: 'lbol', level: 8, cost: 3 }],
    realm,
    level: 10,
    mana: 66,
    sheet,
    family: 'greatermud' as const,
    killConfidence: 0.9
  };

  it("counts casts against the monster's health at the expected damage, and prices each", () => {
    const answer = castsToKill(input, { hp: 60, magicRes: null });
    expect(answer).not.toBeNull();
    expect(answer!.spell).toBe('lightning bolt');
    expect(answer!.mana).toBe(3);
    expect(answer!.rounds).toBeGreaterThanOrEqual(1);
    // Twice the health is at least as many rounds, never fewer.
    expect(castsToKill(input, { hp: 120, magicRes: null })!.rounds).toBeGreaterThanOrEqual(
      answer!.rounds
    );
  });

  it('answers nothing where the book is unread, the health unknown, or nothing casts', () => {
    expect(castsToKill({ book: null }, { hp: 60, magicRes: null })).toBeNull();
    expect(castsToKill(input, { hp: null, magicRes: null })).toBeNull();
    expect(castsToKill({ ...input, book: [] }, { hp: 60, magicRes: null })).toBeNull();
  });
});
