import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../character';
import type { HuntingSpot } from '../hunting';
import { chooseByExp, statGains } from '../statGains';
import {
  raisedBy,
  statSteps,
  wantedByGain,
  type StatLimits,
  type TrainedAttribute
} from '../training';

const CURRENT: Record<TrainedAttribute, number> = {
  strength: 82,
  intellect: 50,
  willpower: 30,
  agility: 80,
  health: 53,
  charm: 50
};

const LIMITS: Record<TrainedAttribute, StatLimits> = {
  strength: { base: 40, max: 100 },
  intellect: { base: 40, max: 100 },
  willpower: { base: 30, max: 30 },
  agility: { base: 60, max: 120 },
  health: { base: 40, max: 100 },
  charm: { base: 40, max: 100 }
};

function soul(): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    progress: { ...base.progress, level: 10, ...CURRENT },
    vitals: { ...base.vitals, hp: 92, hpMax: 92 },
    inventory: { ...base.inventory, encumbrance: 400, encumbranceMax: 3936 }
  };
}

const spot = (expPerHour: number | null): HuntingSpot =>
  ({ estimate: { expPerHour, expPerCycle: null, cycleSeconds: null } }) as unknown as HuntingSpot;

describe('the same character, a stat raised', () => {
  it('raises the figure, and the hit points health brings at this level', () => {
    const raised = raisedBy(soul(), 'health', 10);
    expect(raised.progress.health).toBe(63);
    // Half of 63 less half of 53 (31 − 26), and (13 − 3) × 10 / 16 (8 − 1).
    expect(raised.vitals.hpMax).toBe(92 + 5 + 7);
  });

  it('carries more with strength, and forgets what stat all said', () => {
    const raised = raisedBy({ ...soul(), stated: {} as CharacterState['stated'] }, 'strength', 10);
    expect(raised.inventory.encumbranceMax).toBe(Math.trunc((3936 * 92 * 48) / (82 * 48)));
    expect(raised.stated).toBeNull();
    expect(raisedBy(soul(), null, 0).progress).toEqual(soul().progress);
  });
});

describe('the points weighed', () => {
  it('are the horizon or what is left under the ceiling, never a stat at it', () => {
    const steps = statSteps(CURRENT, LIMITS, 10);
    expect(steps.map((step) => step.attribute)).not.toContain('willpower');
    // Strength 82 from a base of 40: points 83–90 cost 5 each, 91–92 cost 6.
    expect(steps.find((step) => step.attribute === 'strength')).toEqual({
      attribute: 'strength',
      points: 10,
      cost: 8 * 5 + 2 * 6
    });
  });
});

describe('where the points go', () => {
  // The survey pays 100 exp an hour per point of agility, and nothing for the rest.
  const survey = (as: CharacterState): HuntingSpot[] => [spot((as.progress.agility ?? 0) * 100)];

  it('is the stat adding the most exp an hour per CP', () => {
    const { wanted, chose } = chooseByExp(soul(), CURRENT, LIMITS, 10, survey);
    expect(chose?.attribute).toBe('agility');
    expect(chose?.gain).toBe(1000);
    expect(wanted).toEqual({ ...CURRENT, ...zero(), agility: 90 });
  });

  it('is nowhere when no stat adds anything', () => {
    const flat = (): HuntingSpot[] => [spot(5000)];
    expect(chooseByExp(soul(), CURRENT, LIMITS, 10, flat).chose).toBeNull();
  });

  it('counts a ground opened where none was offered as its whole rate', () => {
    // Only with 20 more hit points is anywhere safe to hunt.
    const opens = (as: CharacterState): HuntingSpot[] =>
      (as.vitals.hpMax ?? 0) > 100 ? [spot(3000)] : [];
    const gains = statGains(soul(), statSteps(CURRENT, LIMITS, 10), opens);
    expect(gains.find((gain) => gain.attribute === 'health')?.gain).toBe(3000);
    expect(gains.find((gain) => gain.attribute === 'agility')?.gain).toBeNull();
  });

  it('goes to the cheaper of two stats worth the same', () => {
    const { chose } = wantedByGain(CURRENT, [
      { attribute: 'strength', points: 10, cost: 52, gain: 520 },
      { attribute: 'charm', points: 10, cost: 10, gain: 100 }
    ]);
    expect(chose?.attribute).toBe('charm');
  });
});

function zero(): Record<TrainedAttribute, number> {
  return { strength: 0, intellect: 0, willpower: 0, agility: 0, health: 0, charm: 0 };
}
