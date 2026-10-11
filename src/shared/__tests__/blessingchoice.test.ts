import { describe, expect, it } from 'vitest';

import {
  BLESSING_REFUSALS,
  choiceSentences,
  chooseBlessings,
  type BlessingCandidate,
  type BlessingChoiceInput,
  type FightRun
} from '../blessingchoice';
import { NO_EFFECT, type BlessingEffect } from '../blessingeffects';
import type { WorldSpell } from '../world';

function candidate(
  name: string,
  effect: Partial<BlessingEffect>,
  cost: number,
  seconds: number | null = 180,
  spell: Partial<WorldSpell> = {}
): BlessingCandidate {
  return {
    name,
    spell: { id: name.length * 100 + name.charCodeAt(0), name, ...spell },
    effect: { ...NO_EFFECT, ...effect },
    cost,
    duration: seconds === null ? null : { seconds, from: 'realm' },
    via: { kind: 'book', row: null }
  };
}

/** The same spell, used from a carried item. */
function fromItem(of: BlessingCandidate, item: string, inHand = true): BlessingCandidate {
  return { ...of, name: item, via: { kind: 'item', item, inHand } };
}

/**
 * A fight where armour buys survival and fewer health lost, and maximum
 * damage buys rounds: the shape of the simulator's answers, not its figures.
 */
function fight(base: FightRun) {
  return (set: readonly BlessingCandidate[]): FightRun => {
    const ac = set.reduce((sum, each) => sum + each.effect.armourClass, 0);
    const hit = set.reduce((sum, each) => sum + each.effect.maxDamage, 0);
    return {
      survives: Math.min(1, base.survives + ac * 0.05),
      rounds: base.rounds / (1 + hit * 0.1),
      lostMean: Math.max(0, base.lostMean - ac * 4),
      heals: Math.max(0, base.heals - ac * 0.1)
    };
  };
}

const SAFE_FIGHT: FightRun = { survives: 0.95, rounds: 6, lostMean: 40, heals: 0 };

function input(overrides: Partial<BlessingChoiceInput>): BlessingChoiceInput {
  return {
    candidates: [],
    run: fight(SAFE_FIGHT),
    cycle: {
      expPerHour: 100_000,
      cycleSeconds: 300,
      combatSeconds: 120,
      restSeconds: 100,
      waitSeconds: 0,
      fights: 3
    },
    income: { perHour: 120, meditatingPerSecond: 1 },
    healCost: null,
    safeAbove: 0.6,
    minGain: 0.01,
    manaMax: 40,
    hpMax: 100,
    healReserve: 2,
    roundSeconds: 5,
    ...overrides
  };
}

describe('choosing the blessings that pay', () => {
  it('takes the best gain per mana within the budget, and no more', () => {
    const choice = chooseBlessings(
      input({
        candidates: [
          candidate('tiger', { maxDamage: 3 }, 3),
          candidate('boar', { maxDamage: 3 }, 8),
          candidate('tortoise', { armourClass: 2 }, 3)
        ],
        income: { perHour: 130, meditatingPerSecond: 1 }
      })
    );
    expect(choice.kind).toBe('chosen');
    if (choice.kind !== 'chosen') return;
    expect(choice.by).toBe('exp');
    // Tiger first (cheapest for the rounds it saves); the boar would overspend.
    expect(choice.picks.map((pick) => pick.candidate.name)).toContain('tiger');
    expect(choice.picks.map((pick) => pick.candidate.name)).not.toContain('boar');
    expect(choice.spare).toBeGreaterThanOrEqual(0);
    expect(choice.passed).toContainEqual({ name: 'boar', why: 'over-budget' });
  });

  it('never keeps up two blessings that take each other off', () => {
    const mantis = candidate('mantis', { maxDamage: 2 }, 1, 180, {
      id: 106,
      abilities: [[122, 59]]
    });
    const haste = candidate('haste', { maxDamage: 3 }, 1, 180, { id: 59 });
    const choice = chooseBlessings(input({ candidates: [mantis, haste] }));
    if (choice.kind !== 'chosen') throw new Error(choice.why);
    expect(choice.picks).toHaveLength(1);
    expect(choice.passed.map((each) => each.why)).toEqual(['exclusive']);
  });

  it('gains nothing at a spot the respawn clock bounds', () => {
    const choice = chooseBlessings(
      input({
        candidates: [candidate('tiger', { maxDamage: 3 }, 3)],
        cycle: {
          expPerHour: 50_000,
          cycleSeconds: 600,
          combatSeconds: 60,
          restSeconds: 40,
          waitSeconds: 400,
          fights: 2
        }
      })
    );
    if (choice.kind !== 'chosen') throw new Error(choice.why);
    expect(choice.picks).toEqual([]);
    expect(choice.passed).toEqual([{ name: 'tiger', why: 'no-gain' }]);
  });

  it('weighs survival where the fight is not safe, whatever the exp would say', () => {
    const choice = chooseBlessings(
      input({
        run: fight({ survives: 0.4, rounds: 6, lostMean: 60, heals: 1 }),
        candidates: [
          candidate('tiger', { maxDamage: 6 }, 2),
          candidate('tortoise', { armourClass: 2 }, 3)
        ],
        healCost: 2
      })
    );
    if (choice.kind !== 'chosen') throw new Error(choice.why);
    expect(choice.by).toBe('survival');
    expect(choice.picks.map((pick) => pick.candidate.name)).toEqual(['tortoise']);
    expect(choice.passed).toContainEqual({ name: 'tiger', why: 'no-gain' });
  });

  it('weighs the health a fight costs where it is safe and no spot is hunted', () => {
    const choice = chooseBlessings(
      input({
        cycle: null,
        candidates: [
          candidate('tiger', { maxDamage: 3 }, 3),
          candidate('tortoise', { armourClass: 2 }, 3)
        ]
      })
    );
    if (choice.kind !== 'chosen') throw new Error(choice.why);
    expect(choice.by).toBe('health');
    expect(choice.picks.map((pick) => pick.candidate.name)).toEqual(['tortoise']);
    expect(choice.picks[0]!.gain).toBeCloseTo(0.08);
  });

  /* With no spot hunted the fights run back to back: a round is a second on orohost and five on paramud. */
  it('counts the heals of back-to-back fights at the realm’s round', () => {
    const at = (roundSeconds: number) => {
      const choice = chooseBlessings(
        input({
          cycle: null,
          run: fight({ survives: 0.95, rounds: 6, lostMean: 40, heals: 1 }),
          candidates: [candidate('tortoise', { armourClass: 2 }, 3)],
          healCost: 2,
          income: { perHour: 400, meditatingPerSecond: 0 },
          roundSeconds
        })
      );
      if (choice.kind !== 'chosen') throw new Error(choice.why);
      return { picks: choice.picks.map((pick) => pick.candidate.name), passed: choice.passed };
    };
    expect(at(5).picks).toEqual(['tortoise']);
    expect(at(1)).toEqual({ picks: [], passed: [{ name: 'tortoise', why: 'over-budget' }] });
  });

  it('keeps a derived row’s mana floor for the heals after it', () => {
    const choice = chooseBlessings(
      input({ candidates: [candidate('tortoise', { armourClass: 2 }, 4)], healCost: 6 })
    );
    if (choice.kind !== 'chosen') throw new Error(choice.why);
    expect(choice.picks[0]!.cast).toMatchObject({
      kind: 'book',
      row: { spell: 'tortoise', target: 'self', minMana: (4 + 2 * 6) / 40 }
    });
  });

  it('keeps one spell up once, whether the book or an item casts it', () => {
    const book = candidate('tortoise', { armourClass: 2 }, 3);
    const choice = chooseBlessings(
      input({ candidates: [book, fromItem({ ...book, cost: 2 }, 'shimmering longsword')] })
    );
    if (choice.kind !== 'chosen') throw new Error(choice.why);
    // The item's cast is cheaper here, so it is taken and the book's is passed.
    expect(choice.picks.map((pick) => pick.cast)).toEqual([
      { kind: 'item', item: 'shimmering longsword' }
    ]);
    expect(choice.passed).toEqual([{ name: 'tortoise', why: 'same-spell' }]);
  });

  it('passes over a weapon that blesses while it is in the pack', () => {
    const worn = fromItem(candidate('tiger', { maxDamage: 3 }, 3), 'black flail');
    const packed = fromItem(
      candidate('tortoise', { armourClass: 2 }, 3),
      'large silvery cross',
      false
    );
    const choice = chooseBlessings(input({ candidates: [worn, packed] }));
    if (choice.kind !== 'chosen') throw new Error(choice.why);
    // Positive control: the worn one is weighed and taken.
    expect(choice.picks.map((pick) => pick.candidate.name)).toEqual(['black flail']);
    expect(choice.passed).toEqual([{ name: 'large silvery cross', why: 'not-worn' }]);
  });

  it('waits while a fight it needs is still being run', () => {
    const run = (set: readonly BlessingCandidate[]): FightRun | 'pending' =>
      set.length === 0 ? SAFE_FIGHT : 'pending';
    expect(
      chooseBlessings(input({ run, candidates: [candidate('tiger', { maxDamage: 3 }, 3)] }))
    ).toEqual({
      kind: 'refused',
      why: 'pending'
    });
    expect(chooseBlessings(input({ run: () => 'pending' }))).toEqual({
      kind: 'refused',
      why: 'pending'
    });
  });

  it('refuses on an unknown income, never a guessed one', () => {
    expect(
      chooseBlessings(
        input({ income: null, candidates: [candidate('tiger', { maxDamage: 3 }, 3)] })
      )
    ).toEqual({ kind: 'refused', why: 'unknown-mana' });
  });

  it('passes over a blessing whose cost or duration is unknown', () => {
    const noTime = candidate('owl', { magicRes: 10 }, 2, null);
    const noCost = { ...candidate('cat', { dodge: 2 }, 2), cost: null };
    const choice = chooseBlessings(input({ candidates: [noTime, noCost] }));
    if (choice.kind !== 'chosen') throw new Error(choice.why);
    expect(choice.passed).toEqual([
      { name: 'owl', why: 'unknown-duration' },
      { name: 'cat', why: 'unknown-cost' }
    ]);
  });

  it('says a fight it cannot run, and an empty list', () => {
    expect(chooseBlessings(input({ run: () => null }))).toEqual({ kind: 'refused', why: 'unrun' });
    expect(chooseBlessings(input({}))).toEqual({ kind: 'refused', why: 'no-candidates' });
  });

  it('keeps its refusals in one closed list', () => {
    expect(new Set(BLESSING_REFUSALS).size).toBe(BLESSING_REFUSALS.length);
  });
});

/* Todo 41: the notice and the Spells page are made from the same rows. */
describe('the choice in sentences', () => {
  // Keys and params only, never the wording.
  const t = (key: string, params?: Readonly<Record<string, string | number>>): string =>
    `${key}${JSON.stringify(params ?? {})}`;

  it('is the choice, then what was passed over', () => {
    const view = { room: 'Den', picks: ['a', 'b'], passed: ['c'], refused: null };
    expect(choiceSentences(view, t)).toEqual([
      t('automation.blessing.chose', { room: 'Den', picks: 'a; b' }),
      t('automation.blessing.passed', { passed: 'c' })
    ]);
    // Nothing passed over is one sentence.
    expect(choiceSentences({ ...view, passed: [] }, t)).toHaveLength(1);
  });

  it('is the refusal alone, with the room where there is a fight', () => {
    const refusal = { room: null, picks: [], passed: [], refused: 'why' };
    expect(choiceSentences(refusal, t)).toEqual([
      t('automation.blessing.refusedNoFight', { refused: 'why' })
    ]);
    expect(choiceSentences({ ...refusal, room: 'Den' }, t)).toEqual([
      t('automation.blessing.refused', { room: 'Den', refused: 'why' })
    ]);
  });
});
