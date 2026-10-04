import { describe, expect, it } from 'vitest';

import { RoundClock } from '../RoundClock';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { blockOf } from '../../../shared/__tests__/blocks';

const TUNING = DEFAULT_INTERNAL.tuning;

/*
 * The rounds of one fight, as the capture has them
 * (`2026-10-03_17-51-16_festus.mudcap.jsonl`, t=956178, festus against a
 * vampire bat on Paradigm): five one-round gaps of 5,020-5,052 ms, then a
 * 4,030 ms gap where the server's round came a tick early.
 */
const ROUNDS = [956178, 961230, 966282, 971312, 976346, 981366, 985396];

function clockOver(rounds: readonly number[]): RoundClock {
  const clock = new RoundClock();
  for (const at of rounds) clock.onBlock(blockOf('user-hits', '', {}, at));
  return clock;
}

describe('the next round', () => {
  it('is unknown until a round is seen', () => {
    expect(new RoundClock().next(1000)).toEqual({ known: false });
  });

  it('is a nominal round on from the last round until enough gaps are measured', () => {
    const clock = clockOver(ROUNDS.slice(0, TUNING.combat.roundSamplesLeast));
    const nominal = TUNING.hunting.roundSeconds * 1000;
    expect(clock.next(ROUNDS[2]! + 100)).toEqual({
      known: true,
      at: ROUNDS[2]! + nominal,
      periodMs: nominal
    });
  });

  it('is the median gap on from the last round', () => {
    const clock = clockOver(ROUNDS.slice(0, 6));
    // Gaps 5052, 5052, 5030, 5034, 5020: the median is 5034.
    expect(clock.next(981366 + 1000)).toEqual({
      known: true,
      at: 981366 + 5034,
      periodMs: 5034
    });
    // Two rounds on, with none seen in between.
    expect(clock.next(981366 + 6000)).toEqual({
      known: true,
      at: 981366 + 2 * 5034,
      periodMs: 5034
    });
  });

  it('leaves a tick the server skipped out of the round length, and starts from it', () => {
    const clock = clockOver(ROUNDS);
    expect(clock.next(985396 + 100)).toEqual({
      known: true,
      at: 985396 + 5034,
      periodMs: 5034
    });
  });

  it('keeps counting rounds on from the last one seen, however long ago', () => {
    const clock = clockOver(ROUNDS.slice(0, 6));
    expect(clock.next(981366 + 20 * 5034 + 1)).toEqual({
      known: true,
      at: 981366 + 21 * 5034,
      periodMs: 5034
    });
  });

  it('forgets everything on a new connection', () => {
    const clock = clockOver(ROUNDS);
    clock.reset();
    expect(clock.next(985396 + 100)).toEqual({ known: false });
  });
});
