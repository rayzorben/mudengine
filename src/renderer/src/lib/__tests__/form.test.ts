import { describe, expect, it } from 'vitest';

import { figureOf } from '../form';

/*
 * What a percentage threshold is worth in the character's own numbers.
 *
 * The three ways of answering nothing are the tests worth having: every one of
 * them is `unknown is not zero` in a new place, and each would draw a number
 * somebody could reason about where the client has nothing to say.
 */
describe('the figure behind a percentage', () => {
  it('states the value the threshold fires at', () => {
    expect(figureOf(70, 80)).toBe('56/80');
  });

  it('rounds to whole points, because that is what the client compares', () => {
    // 80 * 0.35 = 28 exactly; 45% of 80 is 36; 33% of 80 is 26.4.
    expect(figureOf(33, 80)).toBe('26/80');
  });

  /*
   * The Global page is edited with no character in the realm at all, a
   * character not yet in the game has no stat sheet, and a warrior has no mana
   * maximum whatsoever. All three are absence, and `0/0` would be the meter
   * painted red for want of a figure.
   */
  it('says nothing when the maximum is unknown', () => {
    expect(figureOf(70, null)).toBeNull();
  });

  it('says nothing for a maximum that has not arrived', () => {
    expect(figureOf(70, 0)).toBeNull();
  });

  /*
   * 0 means *never* in every field this is offered on, so `0/80` would be a
   * true division and a false statement — it names a figure at which nothing
   * happens, and invites somebody to reason about it.
   */
  it('says nothing for a threshold that is off', () => {
    expect(figureOf(0, 80)).toBeNull();
  });

  it('handles a full-health threshold', () => {
    expect(figureOf(100, 334)).toBe('334/334');
  });
});
