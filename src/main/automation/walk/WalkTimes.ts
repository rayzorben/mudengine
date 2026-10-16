/**
 * The walk's two clocks, kept per connection (`Walker.times`, todo 154): how
 * long a step takes (`StepTimes`) and when the next round goes off
 * (`RoundClock`). A run times its steps by them (`OffRounds`) and the game
 * view draws the same figures as the ring round the room (`Publisher`), so
 * the ring shows the off-round the run steps in.
 */
import { tuning } from '../../app/tuning';
import { offRoundMs, type RoundTiming } from '../../../shared/roundTiming';
import { RoundClock } from '../RoundClock';
import { StepTimes } from './StepTimes';

export interface WalkTimes {
  readonly steps: StepTimes;
  readonly rounds: RoundClock;
}

/** The clocks read and never driven: what the window is told from (`roundTimingAt`). */
export interface WalkTimesRead {
  readonly steps: Pick<StepTimes, 'usual'>;
  readonly rounds: Pick<RoundClock, 'next'>;
}

/** A connection's clocks; `speed` is the session's figure for the realm's speed (`RealmSpeed`). */
export function walkTimes(speed: () => number = () => 1): WalkTimes {
  return { steps: new StepTimes(), rounds: new RoundClock(speed) };
}

/** The rounds at `now` as the window is told them, or null before a round is seen. */
export function roundTimingAt(times: WalkTimesRead, now: number): RoundTiming | null {
  const next = times.rounds.next(now);
  if (!next.known) return null;
  const stepMs = times.steps.usual;
  return {
    periodMs: next.periodMs,
    nextInMs: next.at - now,
    offRoundMs:
      stepMs === null ? null : offRoundMs(next.periodMs, stepMs, tuning().walk.offRoundMarginMs)
  };
}
