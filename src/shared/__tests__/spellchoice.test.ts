import { describe, expect, it } from 'vitest';

import {
  castsToKill,
  chooseAttackSpell,
  chooseHealSpell,
  healDeficit,
  healPower,
  mendsTheRound,
  pickHeal,
  spellElementOf,
  thresholdHeal,
  type HealChoiceInput,
  type ThresholdHealInput,
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
  pool: 'MA',
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
    expect(chooseAttackSpell(input({ pool: 'KAI' })).refusal).toBe('kai');
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

  /*
   * Rayzor, 2026-10-05: `harm` is `AffectsLivingOnly` and a zombie is
   * `NonLiving`, and the server answered `Your spell has no effect on big
   * zombie.` and broke the fight at 6 hit points.
   */
  it('never casts a spell the world database says has no effect on the target', () => {
    const living: WorldSpell = { ...REALM['fire jet']!, abilities: [[108, 0]] };
    const nonLiving = {
      remaining: 100,
      magicRes: null,
      abilities: [[66, 100]] as Array<[number, number]>,
      nature: { nonLiving: true, animal: false, undead: true, spellImmunity: [0, 0] as const }
    };
    const realm = (name: string): WorldSpell | null =>
      name === 'fire jet' ? living : (REALM[name] ?? null);
    const choice = chooseAttackSpell(input({ realm, target: nonLiving }));
    expect(choice.chosen?.spell.name).toBe('magic missile');
    // The control: on a living target the jet is still the hardest hitter.
    expect(
      chooseAttackSpell(
        input({
          realm,
          target: { ...nonLiving, nature: { ...nonLiving.nature, nonLiving: false } }
        })
      ).chosen?.spell.name
    ).toBe('fire jet');
    // Where the rows disagree it is cast, and the server's answer settles it.
    expect(
      chooseAttackSpell(
        input({ realm, target: { ...nonLiving, nature: { ...nonLiving.nature, nonLiving: null } } })
      ).chosen?.spell.name
    ).toBe('fire jet');
    // Nothing that touches it: said as its own refusal, not as resisted.
    const only = chooseAttackSpell(input({ book: [BOOK[2]!], realm, target: nonLiving }));
    expect(only.refusal).toBe('no-effect');
  });
});

describe('the round, not the cast', () => {
  // A weaker spell the server casts twice a round outhits a stronger one it casts once.
  it('ranks the hardest hitter by its damage a round', () => {
    const realm = (name: string): WorldSpell | null =>
      name === 'magic missile'
        ? { ...REALM['magic missile']!, energy: 500 }
        : name === 'fire jet'
          ? { ...REALM['fire jet']!, power: [30, 34], energy: 1000 }
          : null;
    const choice = chooseAttackSpell(
      input({ realm, target: { remaining: 500, magicRes: null, abilities: [] } })
    );
    expect(choice.why).toBe('hardest');
    expect(choice.chosen?.spell.name).toBe('magic missile');
    expect(choice.chosen?.casts).toBe(2);
    expect(choice.chosen?.perRound).toBeCloseTo(44);
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
    pool: 'MA' as const,
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

  /*
   * 2026-10-05: Vaelor's magic missile (500 energy) goes twice a round on the
   * wire (`Player.DoMagicRound`), and the survey and the fight run gave it one,
   * so every caster fight read twice as long as it is.
   */
  it('casts as often as the energy buys in a round, and charges the mana of every attempt', () => {
    const twice = (name: string): WorldSpell | null => {
      const row = realm(name);
      return row === null ? null : { ...row, energy: 500, difficulty: 15 };
    };
    const once = castsToKill(
      { ...input, realm: (name) => ({ ...realm(name)!, difficulty: 15 }) },
      {
        hp: 60,
        magicRes: null
      }
    )!;
    const both = castsToKill({ ...input, realm: twice }, { hp: 60, magicRes: null })!;
    expect(both.perRound).toBeCloseTo(once.perRound * 2);
    expect(both.rounds).toBeLessThan(once.rounds);
    // 80% lands at 3 mana, a failure costs 1: 2.6 an attempt, two attempts.
    expect(once.mana).toBeCloseTo(2.6);
    expect(both.mana).toBeCloseTo(5.2);
  });

  it('prices no casting where the only spell has no effect on the monster', () => {
    const living = (name: string): WorldSpell | null => {
      const row = realm(name);
      return row === null ? null : { ...row, abilities: [[108, 0]] };
    };
    const zombie = { nonLiving: true, animal: false, undead: true, spellImmunity: [0, 0] as const };
    expect(
      castsToKill({ ...input, realm: living }, { hp: 60, magicRes: null, nature: zombie })
    ).toBeNull();
    expect(castsToKill({ ...input, realm: living }, { hp: 60, magicRes: null })).not.toBeNull();
  });

  it('answers nothing where the book is unread, the health unknown, or nothing casts', () => {
    expect(castsToKill({ book: null }, { hp: 60, magicRes: null })).toBeNull();
    expect(castsToKill(input, { hp: null, magicRes: null })).toBeNull();
    expect(castsToKill({ ...input, book: [] }, { hp: 60, magicRes: null })).toBeNull();
  });

  // The fight run casts first on this answer (todo 20): a Mystic's kai never buys a round.
  it('answers nothing for a book spent from kai', () => {
    expect(castsToKill({ ...input, pool: 'KAI' }, { hp: 60, magicRes: null })).toBeNull();
  });
});

/*
 * Choosing the heal — todo 01, 2026-09-13, in the player's own figures.
 *
 * A 150-point bar: at 145/150 five points are missing and *minor healing* is
 * the answer, at 90/150 sixty are missing and *major healing* is. One
 * configured spell is wrong at one end or the other, which is the complaint.
 */
const HEALS: Record<string, WorldSpell> = {
  'minor healing': {
    id: 30,
    name: 'minor healing',
    short: 'mihe',
    level: 1,
    mana: 2,
    targets: 2,
    power: [10, 20],
    abilities: [[18, 0]]
  },
  'major healing': {
    id: 31,
    name: 'major healing',
    short: 'mahe',
    level: 8,
    mana: 10,
    targets: 2,
    power: [40, 60],
    abilities: [[18, 0]]
  },
  /* A self-only heal, so the targeting column is exercised both ways. */
  'way of the swan': {
    id: 32,
    name: 'way of the swan',
    short: 'swan',
    level: 4,
    mana: 3,
    targets: 1,
    power: [15, 25],
    abilities: [[18, 0]]
  },
  /* A flat figure on the ability itself, which outranks the rolled power. */
  mend: {
    id: 33,
    name: 'mend',
    short: 'mend',
    level: 1,
    mana: 1,
    targets: 2,
    power: [99, 99],
    abilities: [[18, 6]]
  },
  /* No heal marked at all: an attack spell in the same book. */
  'magic missile': REALM['magic missile']!
};

const HEAL_BOOK = [
  { name: 'minor healing', short: 'mihe', level: 1, cost: 2 },
  { name: 'major healing', short: 'mahe', level: 8, cost: 10 },
  { name: 'way of the swan', short: 'swan', level: 4, cost: 3 },
  { name: 'magic missile', short: 'mmis', level: 1, cost: 2 }
];

const healInput = (over: Partial<HealChoiceInput> = {}): HealChoiceInput => ({
  book: HEAL_BOOK,
  realm: (name) => HEALS[name] ?? null,
  level: 10,
  mana: 50,
  deficit: 60,
  aim: 'self',
  sheet: SHEET,
  family: null,
  ...over
});

describe('what a cast mends', () => {
  it('reads the ability’s own figure where it states one, and the rolled power otherwise', () => {
    expect(healPower(HEALS['minor healing']!, 10)).toEqual([10, 20]);
    expect(healPower(HEALS['mend']!, 10)).toEqual([6, 6]);
  });

  it('answers nothing for a row the realm marks no heal on, or marks a wound on', () => {
    expect(healPower(HEALS['magic missile']!, 10)).toBeNull();
    expect(
      healPower({ id: 9, name: 'damnation', power: [2, 2], abilities: [[18, -2]] }, 10)
    ).toBeNull();
  });
});

describe('choosing the heal', () => {
  it('mends a scratch with the cheapest spell that covers it', () => {
    const choice = chooseHealSpell(healInput({ deficit: 5 }));
    expect(choice.chosen?.spell.name).toBe('minor healing');
    expect(choice.why).toBe('covers');
    expect(choice.chosen?.cost).toBe(2);
  });

  it('mends a real wound with the most any one cast mends', () => {
    const choice = chooseHealSpell(healInput({ deficit: 60 }));
    expect(choice.chosen?.spell.name).toBe('major healing');
    expect(choice.why).toBe('most');
  });

  /*
   * The cheapest that *covers*, not the cheapest outright: at twenty-five
   * missing, the minor heal's fifteen leaves the character still under the
   * ceiling and the round buys nothing that the next round does not.
   */
  it('steps up to the dearer spell the moment the cheap one stops reaching', () => {
    expect(chooseHealSpell(healInput({ deficit: 14 })).chosen?.spell.name).toBe('minor healing');
    expect(chooseHealSpell(healInput({ deficit: 25 })).chosen?.spell.name).toBe('major healing');
  });

  it('never offers a self-only spell for somebody else, and offers it for the caster', () => {
    const forParty = chooseHealSpell(healInput({ aim: 'party', deficit: 20 }));
    expect(forParty.considered.map((c) => c.spell.name)).not.toContain('way of the swan');
    const forSelf = chooseHealSpell(healInput({ aim: 'self', deficit: 20 }));
    expect(forSelf.considered.map((c) => c.spell.name)).toContain('way of the swan');
  });

  it('never offers a spell the pool cannot pay for, or the level cannot reach', () => {
    // Nine mana does not buy the major heal, so the best left is the swan's 20.
    const poor = chooseHealSpell(healInput({ deficit: 60, mana: 9 }));
    expect(poor.chosen?.spell.name).toBe('way of the swan');
    expect(poor.considered.map((c) => c.spell.name)).not.toContain('major healing');
    // And a level-5 character cannot cast the major heal at all.
    const young = chooseHealSpell(healInput({ deficit: 60, level: 5 }));
    expect(young.chosen?.spell.name).toBe('way of the swan');
    expect(young.considered.map((c) => c.spell.name)).not.toContain('major healing');
  });

  it('says which way it could not answer, and never guesses', () => {
    expect(chooseHealSpell({ book: null }).refusal).toBe('no-book');
    expect(chooseHealSpell(healInput({ book: [] })).refusal).toBe('empty-book');
    // A book of attack spells holds no heal at all.
    expect(
      chooseHealSpell(healInput({ book: [{ name: 'magic missile', short: 'mmis', cost: 2 }] }))
        .refusal
    ).toBe('no-heal-spells');
    // Heals it knows, and a pool that cannot pay for any of them.
    expect(chooseHealSpell(healInput({ mana: 1 })).refusal).toBe('no-mana');
  });
});

/*
 * The heal a run fight and the hunting survey price (todo 10, 2026-10-05):
 * both read only `spells.heal`, so under Auto Choose Best Heal they priced a
 * spell `AutoHeal` never cast.
 */
describe('the heal cast at the threshold', () => {
  const at = (over: Partial<ThresholdHealInput> = {}): ThresholdHealInput => ({
    ...healInput(),
    spells: { heal: 'minor healing', healTo: 0.9, autoChooseHeal: false },
    below: 0.5,
    hpMax: 150,
    ...over
  });

  it('is the configured spell with the switch off', () => {
    const heal = thresholdHeal(at());
    expect(heal?.realm.name).toBe('minor healing');
    expect(heal?.restores).toEqual([10, 20]);
    expect(heal?.cost).toBe(2);
    // Cast whatever the round is worth: only a chosen heal is weighed against it.
    expect(heal?.chosenMends).toBeNull();
  });

  it('is the one chosen against the deficit under the threshold with the switch on', () => {
    // 74 of 150 up to 135 is 61 missing: nothing covers it, so the most.
    const wide = thresholdHeal(
      at({ spells: { heal: 'minor healing', healTo: 0.9, autoChooseHeal: true } })
    );
    expect(wide?.realm.name).toBe('major healing');
    expect(wide?.chosenMends).toBeGreaterThan(0);
    // 74 up to 90 is 16: the minor heal's 15 falls short, the swan's 20 covers it.
    const narrow = thresholdHeal(
      at({ spells: { heal: 'minor healing', healTo: 0.6, autoChooseHeal: true } })
    );
    expect(narrow?.realm.name).toBe('way of the swan');
  });

  it('falls back to the configured spell where the choice cannot answer, as AutoHeal does', () => {
    const spells = { heal: 'minor healing', healTo: 0.9, autoChooseHeal: true };
    expect(thresholdHeal(at({ spells, book: null }))?.realm.name).toBe('minor healing');
    expect(thresholdHeal(at({ spells, hpMax: null }))?.realm.name).toBe('minor healing');
  });

  it('is nothing with no threshold, the level unread, no spell, or a row that mends nothing', () => {
    expect(thresholdHeal(at({ below: 0 }))).toBeNull();
    expect(thresholdHeal(at({ level: null }))).toBeNull();
    expect(
      thresholdHeal(at({ spells: { heal: '', healTo: 0.9, autoChooseHeal: false } }))
    ).toBeNull();
    expect(
      thresholdHeal(at({ spells: { heal: 'magic missile', healTo: 0.9, autoChooseHeal: false } }))
    ).toBeNull();
  });
});

describe('the hit points a heal wants back', () => {
  it('runs to the ceiling, or the bar’s top with none stated, and is unknown unread', () => {
    expect(healDeficit(0.8, 50, 100)).toBe(30);
    expect(healDeficit(0, 50, 100)).toBe(50);
    expect(healDeficit(0.8, null, 100)).toBeNull();
    expect(healDeficit(0.8, 50, null)).toBeNull();
  });
});

describe('which heal AutoHeal casts', () => {
  const choose = (deficit: number) => chooseHealSpell(healInput({ deficit }));
  const round = (floor: number) => () => ({ floor });

  it('casts the configured spell with the switch off, the deficit unread or the choice refused', () => {
    expect(pickHeal(false, 30, choose, null)).toEqual({ kind: 'configured', why: 'switched-off' });
    expect(pickHeal(true, null, choose, null)).toEqual({ kind: 'configured', why: 'no-figures' });
    const refused = pickHeal(true, 30, () => chooseHealSpell({ book: null }), null);
    expect(refused).toEqual({ kind: 'refused', refusal: 'no-book' });
  });

  it('casts the chosen heal, and in a fight only where it mends the round, never falling back', () => {
    expect(pickHeal(true, 5, choose, null).kind).toBe('chosen');
    expect(pickHeal(true, 5, choose, round(1)).kind).toBe('chosen');
    const short = pickHeal(true, 5, choose, round(100));
    expect(short.kind).toBe('too-little');
    expect(mendsTheRound(15, 15)).toBe(true);
    expect(mendsTheRound(14, 15)).toBe(false);
  });
});
