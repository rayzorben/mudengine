import { describe, expect, it } from 'vitest';

import { LairCosts } from '../LairCosts';
import type { LairPass } from '../../../shared/verdict';

/** A weighed pass, damage alone where the certainty is not what is under test. */
const pass = (damage: number, sure = true): LairPass => ({ damage, sure });

describe('what a lair costs, remembered per character', () => {
  it('weighs a room once under one fitness, null included', () => {
    let asked = 0;
    const costs = new LairCosts((room) => {
      asked += 1;
      return room === '1/1' ? pass(25) : null;
    });
    expect(costs.at('L10', '1/1')).toEqual(pass(25));
    expect(costs.at('L10', '1/1')).toEqual(pass(25));
    expect(costs.at('L10', '1/2')).toBeNull();
    expect(costs.at('L10', '1/2')).toBeNull();
    expect(asked).toBe(2);
    expect(costs.size).toBe(2);
  });

  it('drops everything the moment the character changes', () => {
    let level = 10;
    const costs = new LairCosts(() => pass(100 / level));
    expect(costs.at(`L${level}`, '1/1')).toEqual(pass(10));
    // A level gained: the same room is a different question.
    level = 20;
    expect(costs.at(`L${level}`, '1/1')).toEqual(pass(5));
    expect(costs.size).toBe(1);
    // And back again is weighed again, not remembered from before.
    level = 10;
    expect(costs.at(`L${level}`, '1/1')).toEqual(pass(10));
  });
});
