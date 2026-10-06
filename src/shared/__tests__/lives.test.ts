import { describe, expect, it } from 'vitest';

import {
  asLowLives,
  asLowLivesAnswer,
  atLivesFloor,
  DEFAULT_LOW_LIVES,
  LOW_LIVES_ANSWERS
} from '../lives';

describe('the lives floor', () => {
  it('is reached at the floor and below it', () => {
    expect(atLivesFloor(2, 2)).toBe(true);
    expect(atLivesFloor(1, 2)).toBe(true);
    expect(atLivesFloor(3, 2)).toBe(false);
  });

  /* Unknown is not low, as in `GearRecovery`: a count never read stops nothing. */
  it('is never reached at a floor of 0, or with the lives unread', () => {
    expect(atLivesFloor(0, 0)).toBe(false);
    expect(atLivesFloor(null, 2)).toBe(false);
  });
});

describe("a character file's lowLives", () => {
  /* The nearest count the client can use, as `int` gives every count; nothing at all is the default. */
  it('clamps to 0–99, and takes the default for a blank', () => {
    expect(asLowLives(0)).toBe(0);
    expect(asLowLives(5)).toBe(5);
    expect(asLowLives('3')).toBe(3);
    expect(asLowLives(-1)).toBe(0);
    expect(asLowLives(150)).toBe(99);
    expect(asLowLives(undefined)).toBe(DEFAULT_LOW_LIVES);
    expect(asLowLives('')).toBe(DEFAULT_LOW_LIVES);
  });
});

describe('an answer from a window', () => {
  it('is one of the three, or nothing', () => {
    for (const answer of LOW_LIVES_ANSWERS) expect(asLowLivesAnswer(answer)).toBe(answer);
    expect(asLowLivesAnswer('yes')).toBeNull();
    expect(asLowLivesAnswer(null)).toBeNull();
  });
});
