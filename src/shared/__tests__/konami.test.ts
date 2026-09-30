import { describe, expect, it } from 'vitest';

import { attackOptions } from '../attackOptions';
import { EMPTY_CHARACTER, type CharacterState } from '../character';
import { DEFAULT_CONFIG } from '../config';
import { NO_EXCLUSIONS, type HuntingAdvice, type HuntingSpot, type SpotEstimate } from '../hunting';
import {
  asKonamiReply,
  cashStep,
  layered,
  layerWrites,
  type KonamiQuestion,
  type KonamiReply
} from '../konami';
import { buildBrief, leftOutWhy, type KonamiBrief, type SlotUpgrade } from '../konamiBrief';
import type { KonamiLesson } from '../konamiLessons';
import { nextUpgradePrice, planQuestions, readPlan, samePlan } from '../konamiQuestions';
import type { ProwessSheet } from '../prowess';

describe('the cash steps a new plan is asked on', () => {
  it('climbs 1p, 10p, 20p … 90p, then a runic at a time', () => {
    expect(cashStep(null)).toBeNull();
    expect(cashStep(9_999)).toBe(0);
    expect(cashStep(10_000)).toBe(1);
    expect(cashStep(99_999)).toBe(1);
    expect(cashStep(100_000)).toBe(2);
    expect(cashStep(200_000)).toBe(3);
    expect(cashStep(999_999)).toBe(10);
    expect(cashStep(1_000_000)).toBe(11);
    expect(cashStep(2_500_000)).toBe(12);
  });
});

describe("the provider's reply, parsed at the boundary", () => {
  const questions: Record<string, KonamiQuestion> = {
    goal: { type: 'choice', instructions: '', criteria: { hunt_0: '', wait: '' } },
    sneak: { type: 'noul', instructions: '', criteria: { true: '', false: '' } }
  };
  const good = {
    model: 'm',
    answers: {
      goal: {
        type: 'choice',
        choice: 'hunt_0',
        confidence: 0.8,
        probabilities: { hunt_0: 0.8, wait: 0.2 }
      },
      sneak: { type: 'noul', noul: 0.3 }
    }
  };

  it('takes a reply that answers every question with an offered label', () => {
    expect(asKonamiReply(good, questions)?.answers['goal']).toMatchObject({ choice: 'hunt_0' });
  });

  it('refuses a label that was never offered, a missing answer or a probability out of range', () => {
    const offLabel = structuredClone(good);
    offLabel.answers.goal.choice = 'buy_head_0';
    expect(asKonamiReply(offLabel, questions)).toBeNull();
    const missing = { model: 'm', answers: { goal: good.answers.goal } };
    expect(asKonamiReply(missing, questions)).toBeNull();
    const wild = structuredClone(good);
    wild.answers.sneak.noul = 1.4;
    expect(asKonamiReply(wild, questions)).toBeNull();
  });
});

describe("the plan's settings over the character's own", () => {
  const own = DEFAULT_CONFIG.automation;

  it('changes only what the layer names, and the one switch the goal needs', () => {
    const out = layered(own, { attack: 'pu', sneak: true }, 'hunt');
    expect(out.combat.attack).toBe('pu');
    expect(out.movement.sneak).toBe(true);
    expect(out.combat.opener).toBe(own.combat.opener);
    expect(out.hunting.enabled).toBe(true);
    expect(out.train.levels).toBe(own.train.levels);
    expect(out.supplies.enabled).toBe(own.supplies.enabled);
    expect(layered(own, {}, 'buy').supplies.enabled).toBe(true);
    expect(layered(own, {}, 'wait').hunting.enabled).toBe(own.hunting.enabled);
    // The player's own is untouched.
    expect(own.combat.attack).toBe(DEFAULT_CONFIG.automation.combat.attack);
  });

  it('keeps rest-to at or above rest-below, and hides for an opener', () => {
    const out = layered(own, { restBelow: 0.9, opener: 'bs' }, 'wait');
    expect(out.health.restTo).toBeGreaterThanOrEqual(0.9);
    expect(out.combat.hideForOpener).toBe(true);
  });

  it('writes to the file only what the layer names, never a goal’s switch', () => {
    const paths = layerWrites(own, { heal: 'auto', trainFirst: 'agility' }).map(([path]) =>
      path.join('.')
    );
    expect(paths).toEqual(['spells.autoChooseHeal', 'train.stats', 'train.wanted.agility']);
  });
});

const SHEET: ProwessSheet = {
  level: 10,
  agility: 60,
  intellect: 50,
  charm: 55,
  willpower: 50,
  health: 60,
  strength: 55,
  spellcasting: 40,
  combatLevel: 4,
  mageryLevel: null,
  encumbrancePercent: 20,
  stated: null
};

describe('the attacks a class is offered', () => {
  it('offers the plain attack always and the rest only where the class row holds it', () => {
    const plain = attackOptions(SHEET, null, [], 'greatermud').map((option) => option.verb);
    expect(plain).toEqual(['a']);
    const mystic = attackOptions(
      SHEET,
      null,
      [
        [29, 1],
        [30, 1],
        [35, 1],
        [93, 3]
      ],
      'greatermud'
    );
    expect(mystic.map((option) => option.verb)).toEqual(['a', 'pu', 'kic', 'ju']);
    expect(mystic.every((option) => option.perRound !== null)).toBe(true);
  });

  it('offers only the plain attack while the class row is unread', () => {
    expect(attackOptions(SHEET, null, null, 'greatermud').map((option) => option.verb)).toEqual([
      'a'
    ]);
  });
});

const estimate = (over: Partial<SpotEstimate>): SpotEstimate =>
  ({
    expPerHour: 12_000,
    ceilingPerHour: null,
    expPerCycle: 400,
    worstShare: 0.2,
    unknown: [],
    ...over
  }) as unknown as SpotEstimate;

const spot = (key: string, over: Partial<SpotEstimate> = {}): HuntingSpot =>
  ({
    key,
    mobs: [{ name: 'fierce zombie', experience: 70, rounds: 3, perRound: 6 }],
    rooms: [{ id: '1/2', map: 1, room: 2, name: 'Graveyard', steps: 5 }],
    walk: [],
    loopSteps: 6,
    boss: false,
    respawnSeconds: 60,
    estimate: estimate(over)
  }) as unknown as HuntingSpot;

const HELM: SlotUpgrade = {
  slot: 'Head',
  worn: null,
  wornFigure: null,
  wornDr: null,
  ranking: 'armour',
  offers: [
    {
      item: 7,
      name: 'padded helm',
      figure: 2,
      ac: 2,
      dr: 0,
      minLevel: null,
      shop: 'Armoury',
      at: { map: 1, room: 9 },
      moves: 3,
      copper: 500,
      effect: null
    },
    {
      item: 8,
      name: 'iron helm',
      figure: 6,
      ac: 6,
      dr: 1,
      minLevel: null,
      shop: 'Armoury',
      at: { map: 1, room: 9 },
      moves: 3,
      copper: 50_000,
      effect: null
    }
  ]
};

function brief(over: Partial<CharacterState> = {}, lessons: KonamiLesson[] = []): KonamiBrief {
  const base = structuredClone(EMPTY_CHARACTER);
  const state: CharacterState = {
    ...base,
    phase: 'in-game',
    progress: { ...base.progress, level: 10, expNeeded: 0 },
    inventory: { ...base.inventory, wealth: 1_000 },
    banks: [{ shop: 3, name: 'Bank', copper: 2_000, at: 0 }],
    ...over
  };
  const advice = {
    from: { id: '1/1', name: 'Town Gates' },
    spots: [spot('lair:a'), spot('lair:b', { worstShare: null, unknown: ['rounds'] })],
    excluded: { ...NO_EXCLUSIONS, dangerous: 2, unsurvivable: 1 },
    refusal: null
  } as unknown as HuntingAdvice;
  return buildBrief({
    state,
    advice,
    entities: new Map(),
    gear: [HELM],
    attacks: attackOptions(SHEET, null, [[29, 1]], 'greatermud'),
    openers: ['bs'],
    canSneak: true,
    spells: [
      { name: 'minor healing', word: 'mihe', cost: 3, heals: true, blessing: false },
      { name: 'bless', word: 'bles', cost: 5, heals: false, blessing: true }
    ],
    settings: {
      attack: 'a',
      opener: '',
      sneak: false,
      heal: '',
      blessings: [],
      restBelow: 0.35,
      trainFirst: null
    },
    maxSpots: 10,
    lessons,
    walk: () => null,
    simulated: () => null,
    now: 1
  });
}

describe('the brief', () => {
  it('gives each spot what choosing it came to before, and every lesson whole', () => {
    const died: KonamiLesson = {
      at: 5,
      goal: { kind: 'hunt', key: 'lair:a', name: 'fierce zombie' },
      level: 10,
      hpMax: 100,
      armourClass: 3,
      attack: 'a',
      outcome: 'died',
      why: null,
      killers: ['fierce bandit'],
      room: 'Main Road',
      atTheSpot: false,
      expGained: null,
      minutes: 2
    };
    const made = brief({}, [died]);
    expect(made.history).toEqual([died]);
    expect(made.hunting.spots[0]!.history).toHaveLength(1);
  });

  it('counts the bank into the cash and leaves out a spot whose damage is unknown, saying why', () => {
    const made = brief();
    expect(made.character.cash.total).toBe(3_000);
    expect(made.hunting.spots.map((row) => row.key)).toEqual(['lair:a']);
    expect(made.hunting.leftOut).toEqual([
      { key: 'lair:b', name: 'fierce zombie', why: 'damage-unknown' }
    ]);
    expect(leftOutWhy(spot('x', { expPerHour: null, expPerCycle: null }))).toBe('rate-unknown');
  });

  it('says an unread purse is no cash at all rather than nothing', () => {
    const base = structuredClone(EMPTY_CHARACTER);
    expect(
      brief({ inventory: { ...base.inventory, wealth: null } }).character.cash.total
    ).toBeNull();
  });
});

describe('the questions and the plan their answers make', () => {
  const answer = (choices: Record<string, string>, yes: Record<string, number>): KonamiReply => ({
    model: 'm',
    answers: {
      ...Object.fromEntries(
        Object.entries(choices).map(([name, choice]) => [
          name,
          { type: 'choice' as const, choice, confidence: 0.7, probabilities: { [choice]: 0.7 } }
        ])
      ),
      ...Object.fromEntries(
        Object.entries(yes).map(([name, noul]) => [name, { type: 'noul' as const, noul }])
      )
    }
  });

  it('offers only what the cash covers, the level that is ready, and staying put', () => {
    const asked = planQuestions(brief());
    const goal = asked.questions['goal'];
    expect(goal?.type).toBe('choice');
    const labels = Object.keys(goal?.type === 'choice' ? goal.criteria : {});
    expect(labels).toEqual(['hunt_0', 'buy_head_0', 'train', 'wait']);
    expect(Object.keys(asked.questions)).toEqual(
      expect.arrayContaining(['attack', 'opener', 'sneak', 'heal', 'bless_bles', 'restBelow'])
    );
  });

  it('turns the answers into a goal and the settings to go with it', () => {
    const asked = planQuestions(brief());
    const plan = readPlan(
      answer(
        {
          goal: 'buy_head_0',
          attack: 'pu',
          opener: 'none',
          heal: 'auto',
          restBelow: 'rest_60',
          trainFirst: 'agility'
        },
        { sneak: 0.9, bless_bles: 0.2 }
      ),
      asked
    );
    expect(plan.goal).toMatchObject({ kind: 'buy', name: 'padded helm', copper: 500 });
    expect(plan.layer).toEqual({
      attack: 'pu',
      opener: '',
      sneak: true,
      heal: 'auto',
      blessings: [],
      restBelow: 0.6,
      trainFirst: 'agility'
    });
    expect(samePlan(plan, { ...plan, picks: [] })).toBe(true);
  });

  it('names the cheapest upgrade still out of reach', () => {
    expect(nextUpgradePrice(brief())).toBe(50_000);
  });
});
