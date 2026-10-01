import { describe, expect, it } from 'vitest';

import { DEFAULT_INTERNAL } from '../internal';
import type { KonamiBrief } from '../konamiBrief';
import { planQuestions } from '../konamiQuestions';
import { savingOffers } from '../konamiSaving';
import {
  fitRequest,
  onlyGoal,
  requestSizes,
  requestSubstance,
  wireState,
  type KonamiWireState
} from '../konamiWire';
import fixture from './konamiBrief.fixture.json';

/**
 * The brief the provider refused on 2026-10-01 (`max_tokens_exceeded`): a
 * level-2 Mystic at the cave bear with 573 copper, a level ready at 50, eight
 * spots with every monster's attack rows, fifteen slots of gear.
 */
const REFUSED = fixture as unknown as KonamiBrief;

const SIZES = requestSizes(DEFAULT_INTERNAL.tuning.konami);
const LIMITS = SIZES.limits;
const { upgradesPerSlot } = DEFAULT_INTERNAL.tuning.konami;

/** The same brief, not yet ready to train, so the goal question offers grounds and gear. */
function hunting(brief: KonamiBrief = REFUSED): KonamiBrief {
  const copy = structuredClone(brief);
  copy.character.levelReady = false;
  return copy;
}

describe('the request sent to the provider', () => {
  it('was over the size the provider takes, sent whole', () => {
    const whole = {
      state: REFUSED,
      questions: planQuestions(hunting(), SIZES.questions).questions
    };
    expect(JSON.stringify(whole).length).toBeGreaterThan(60_000);
  });

  it('fits the budget at the shipped limits, with nothing trimmed past them', () => {
    const fitted = fitRequest(hunting(), SIZES);
    expect(fitted.over).toBe(false);
    expect(fitted.chars).toBeLessThanOrEqual(SIZES.budget);
    expect(fitted.chars).toBe(JSON.stringify(fitted.sent).length);
    expect(fitted.limits).toEqual(LIMITS);
  });

  it('sends grounds as what they yield, never their monsters, attacks or lairs', () => {
    const { sent } = fitRequest(hunting(), SIZES);
    const state = sent.state as KonamiWireState;
    const text = JSON.stringify(state);
    for (const key of ['"mobs"', '"attacks":[{"kind"', '"route"', '"worst"', '"survival"']) {
      expect(text).not.toContain(key);
    }
    expect(state.grounds[0]).toMatchObject({
      name: 'cave bear',
      expPerHour: expect.any(Number),
      copperPerHour: expect.any(Number),
      survives: 100
    });
  });

  it('offers only grounds and items the state lists', () => {
    const { sent, asked } = fitRequest(hunting(), SIZES);
    const state = sent.state as KonamiWireState;
    const grounds = new Set(state.grounds.map((ground) => ground.key));
    const items = new Set(state.gear.flatMap((slot) => slot.offers.map((offer) => offer.name)));
    for (const goal of Object.values(asked.labels.goal)) {
      if (goal.kind === 'hunt') expect(grounds.has(goal.key)).toBe(true);
      if (goal.kind === 'buy') expect(items.has(goal.name)).toBe(true);
    }
    for (const slot of state.gear) expect(slot.offers.length).toBeLessThanOrEqual(upgradesPerSlot);
  });

  it('trims lessons, then offers, then grounds, to fit a smaller budget', () => {
    const fitted = fitRequest(hunting(), { ...SIZES, budget: 6_000 });
    expect(fitted.limits.lessons).toBeLessThan(LIMITS.lessons);
    expect(fitted.limits.offersPerSlot).toBe(1);
    expect(fitted.limits.grounds).toBeLessThan(LIMITS.grounds);
  });

  it('says so when even the smallest trim is over', () => {
    const fitted = fitRequest(hunting(), { ...SIZES, budget: 100 });
    expect(fitted.over).toBe(true);
    expect(fitted.limits).toEqual(SIZES.floor);
  });

  it('states every stat the sheet does, and leaves out one it does not', () => {
    const state = wireState(REFUSED);
    expect(state.character.stats['strength']).toBe(60);
    expect('spellcasting' in state.character.stats).toBe(false);
  });
});

describe('what an ask decides', () => {
  it('is a level that is ready and paid for, with nothing else offered', () => {
    expect(onlyGoal(fitRequest(REFUSED, SIZES))).toEqual({ kind: 'train' });
    expect(onlyGoal(fitRequest(hunting(), SIZES))).toBeNull();
  });

  it('is the same ask while only the figures drift', () => {
    const before = requestSubstance(fitRequest(hunting(), SIZES));
    const drifted = hunting();
    drifted.character.exp = (drifted.character.exp ?? 0) + 5_000;
    drifted.hunting.spots[0]!.exp.perHour = 1;
    expect(requestSubstance(fitRequest(drifted, SIZES))).toBe(before);
  });

  it('is a different ask once the purse reaches an item it did not', () => {
    const before = requestSubstance(fitRequest(hunting(), SIZES));
    const richer = hunting();
    richer.character.cash = { onHand: 1_000_000, banks: [], total: 1_000_000 };
    expect(requestSubstance(fitRequest(richer, SIZES))).not.toBe(before);
  });
});

describe('saving for something', () => {
  it('offers the cheapest item out of reach per slot, cheapest first, no more than tuned', () => {
    const poor = hunting();
    poor.character.cash = { onHand: 0, banks: [], total: 0 };
    const offers = Object.values(savingOffers(poor, SIZES.questions.savingGear));
    expect(offers.length).toBeLessThanOrEqual(SIZES.questions.savingGear);
    const prices = offers.map((offer) => offer.copper);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });
});
