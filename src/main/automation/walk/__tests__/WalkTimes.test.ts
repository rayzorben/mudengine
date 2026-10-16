import { describe, expect, it } from 'vitest';

import { roundTimingAt, walkTimes } from '../WalkTimes';
import { blockOf } from '../../../../shared/__tests__/blocks';
import { offRoundMs } from '../../../../shared/roundTiming';
import { DEFAULT_INTERNAL } from '../../../../shared/internal';

const { offRoundMarginMs: MARGIN, offRoundStepSamples: STEPS } = DEFAULT_INTERNAL.tuning.walk;

/* festus against a vampire bat on Paradigm (2026-10-03_17-51-16_festus.mudcap.jsonl, t=956178). */
const ROUNDS = [956178, 961230, 966282, 971312, 976346];

describe('what the window is told of the rounds', () => {
  it('is nothing before a round is seen', () => {
    expect(roundTimingAt(walkTimes(), 0)).toBeNull();
  });

  it('is the next round from now, with no off-round until a step is timed', () => {
    const times = walkTimes();
    for (const at of ROUNDS) times.rounds.onBlock(blockOf('user-hits', '', {}, at));
    const now = ROUNDS.at(-1)! + 1000;
    const next = times.rounds.next(now);
    if (!next.known) throw new Error('no round known');
    expect(roundTimingAt(times, now)).toEqual({
      periodMs: next.periodMs,
      nextInMs: next.at - now,
      offRoundMs: null
    });
  });

  it('gives the off-round the run steps in once a step is timed', () => {
    const times = walkTimes();
    for (const at of ROUNDS) times.rounds.onBlock(blockOf('user-hits', '', {}, at));
    for (let i = 0; i < STEPS; i++) {
      times.steps.sent(i * 2000);
      times.steps.answered(i * 2000 + 1239);
    }
    const timing = roundTimingAt(times, ROUNDS.at(-1)! + 1000);
    expect(timing?.offRoundMs).toBe(offRoundMs(timing!.periodMs, 1239, MARGIN));
  });
});
