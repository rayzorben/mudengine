import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState, type PartyMember } from '../character';
import { healTargets, planHeal, relief, type HealPlanInput, type HealTarget } from '../healplan';
import type { ProwessSheet } from '../prowess';
import type { WorldSpell } from '../world';

/*
 * The GreaterMUD realm's own rows (realm format 48, spells 17, 145 and 123),
 * so the arithmetic is the server's: at level 24 major healing mends 14-34,
 * healing rain 12-22 on everybody, greater healing rain 27-59.
 */
const REALM: Record<string, WorldSpell> = {
  'major healing': {
    id: 17,
    name: 'major healing',
    short: 'mahe',
    level: 8,
    mana: 6,
    targets: 2,
    abilities: [[18, 0]],
    power: [6, 10],
    cap: 30,
    minGrowth: [3, 1],
    maxGrowth: [1, 1]
  },
  'healing rain': {
    id: 145,
    name: 'healing rain',
    short: 'rain',
    level: 10,
    mana: 5,
    targets: 13,
    abilities: [[18, 0]],
    power: [4, 10],
    cap: 25,
    minGrowth: [3, 1],
    maxGrowth: [2, 1]
  },
  'greater healing rain': {
    id: 123,
    name: 'greater healing rain',
    short: 'grai',
    level: 24,
    mana: 30,
    targets: 13,
    abilities: [[18, 0]],
    power: [15, 35],
    cap: 46,
    minGrowth: [2, 1],
    maxGrowth: [1, 1]
  }
};

const SHEET: ProwessSheet = {
  level: 24,
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

const book = (...names: string[]) =>
  names.map((name) => ({
    name,
    short: REALM[name]!.short ?? name,
    level: REALM[name]!.level ?? null,
    cost: REALM[name]!.mana ?? null
  }));

/** A member at `percent` of 100 hit points, wanted under the 50% floor. */
const at = (name: string | null, percent: number, floor = 50): HealTarget => ({
  name,
  wanted: percent < floor,
  hp: percent,
  hpMax: 100
});

const input = (targets: HealTarget[], over: Partial<HealPlanInput> = {}): HealPlanInput => ({
  book: book('major healing', 'healing rain'),
  realm: (name) => REALM[name] ?? null,
  level: 24,
  mana: 100,
  sheet: SHEET,
  family: null,
  targets,
  ceiling: 0.9,
  urgency: 2,
  nearEnough: 0.05,
  partyWide: true,
  ...over
});

describe('what a point mended is worth', () => {
  it('counts a point low on the bar for more than one near the top', () => {
    expect(relief(0.3, 0.4, 2)).toBeGreaterThan(relief(0.8, 0.9, 2) * 5);
  });

  it('is nothing for a bar that does not move', () => {
    expect(relief(0.5, 0.5, 2)).toBe(0);
    expect(relief(0.5, 0.4, 2)).toBe(0);
  });
});

describe('one heal or a party heal', () => {
  /* The todo's own figures: one member under the floor is one heal. */
  it('casts the best single heal on the one at 35% when the others are at 68% and 71%', () => {
    const plan = planHeal(input([at(null, 90), at('Ann', 68), at('Bo', 71), at('Cy', 35)]));
    expect(plan?.kind).toBe('single');
    if (plan?.kind !== 'single') return;
    expect(plan.target.name).toBe('Cy');
    expect(plan.choice.chosen.spell.name).toBe('major healing');
  });

  it('casts the rain when two are under the floor', () => {
    const plan = planHeal(input([at(null, 90), at('Ann', 45), at('Cy', 40)]));
    expect(plan?.kind).toBe('area');
    if (plan?.kind !== 'area') return;
    expect(plan.cast.spell.name).toBe('healing rain');
    expect(plan.reaches).toBe(2);
  });

  it('counts this character among those a rain reaches', () => {
    const plan = planHeal(input([at(null, 40), at('Ann', 45)]));
    expect(plan?.kind).toBe('area');
  });

  it('takes the dearer rain when it does far more for the party', () => {
    const plan = planHeal(
      input([at(null, 30), at('Ann', 25), at('Cy', 20)], {
        book: book('major healing', 'healing rain', 'greater healing rain')
      })
    );
    expect(plan?.kind).toBe('area');
    if (plan?.kind !== 'area') return;
    expect(plan.cast.spell.name).toBe('greater healing rain');
  });

  it('takes the cheaper option where two do as much, as the single heal does', () => {
    // Four points missing: every spell covers it, so the price decides.
    const plan = planHeal(
      input([{ name: 'Cy', wanted: true, hp: 86, hpMax: 100 }], {
        book: book('major healing', 'greater healing rain')
      })
    );
    expect(plan?.kind).toBe('single');
  });

  it('never casts what the pool cannot pay for', () => {
    const plan = planHeal(input([at(null, 45), at('Ann', 45), at('Cy', 40)], { mana: 5 }));
    expect(plan?.kind).toBe('area');
    const broke = planHeal(input([at(null, 45), at('Ann', 45)], { mana: 4 }));
    expect(broke).toBeNull();
  });

  it('never casts a party heal with party healing off', () => {
    const plan = planHeal(input([at(null, 45), at('Ann', 45), at('Cy', 40)], { partyWide: false }));
    expect(plan?.kind).toBe('single');
  });

  it('chooses nothing where nobody wants a heal', () => {
    expect(planHeal(input([at(null, 90), at('Ann', 68)]))).toBeNull();
  });
});

describe('who a heal could reach', () => {
  const member = (name: string, health: number | null, over: Partial<PartyMember> = {}) => ({
    name,
    className: null,
    health,
    mana: null,
    rank: null,
    activity: null,
    invited: false,
    vitals: null,
    ...over
  });
  const state = (members: PartyMember[]): CharacterState => ({
    ...structuredClone(EMPTY_CHARACTER),
    name: 'Vaelor',
    vitals: { ...EMPTY_CHARACTER.vitals, hp: 45, hpMax: 100 },
    party: { following: null, members, engaged: {}, threatened: {} }
  });
  const below = (_key: string | null, share: number | null) => share !== null && share < 0.5;

  it('splits the party by whether their own client said the figures', () => {
    const { figured, unfigured } = healTargets(
      state([
        member('Vaelor', 0.45),
        member('Ann', 0.3, { vitals: { hp: 30, hpMax: 100, mana: null, manaMax: null } }),
        member('Bo', 0.2),
        member('Cy', 0.8),
        member('Dee', 0.1, { invited: true })
      ]),
      true,
      below,
      (key) => key === 'cy'
    );
    expect(figured.map((target) => [target.name, target.wanted])).toEqual([
      [null, true],
      ['Ann', true]
    ]);
    // Cy asked, so is wanted at any figure; Dee's invitation is not membership.
    expect(unfigured).toEqual([
      { name: 'Bo', share: 0.2, asked: false },
      { name: 'Cy', share: 0.8, asked: true }
    ]);
  });

  it('reaches this character alone without party healing', () => {
    const { figured, unfigured } = healTargets(
      state([member('Bo', 0.2)]),
      false,
      below,
      () => false
    );
    expect(figured).toHaveLength(1);
    expect(unfigured).toEqual([]);
  });
});
