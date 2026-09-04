import { describe, expect, it } from 'vitest';

import { CALM, nextPressure, type PressureLimits } from '../useStreamPressure';

/** The shipped numbers, so these cases are about the values that actually run. */
const LIMITS: PressureLimits = { highWater: 1500, highSamples: 4, calmSamples: 8 };

/** Feeds a series of rates through the decision and returns where it lands. */
const feed = (rates: number[], limits: PressureLimits = LIMITS) =>
  rates.reduce((run, rate) => nextPressure(run, rate, limits), CALM);

/**
 * A quarter-second sample of one combat round.
 *
 * ~600 bytes of coloured text in one packet over a 250ms window is 2400
 * characters per second — comfortably over the water line, which is the whole
 * point: the rate is real, and it is still not pressure.
 */
const ONE_ROUND = 2400;

describe('the pressure decision', () => {
  it('does not quiet the chrome for a single burst', () => {
    expect(feed([ONE_ROUND]).pressure).toBe('calm');
  });

  /*
   * The case that was actually reported: a round every few seconds, each one
   * arriving in a single packet, for as long as somebody is fighting. Every
   * one of these used to dim the whole window and relax two seconds later.
   */
  it('stays calm through a fight of one round every few seconds', () => {
    const rounds = Array.from({ length: 8 }).flatMap(() => [ONE_ROUND, 0, 0, 0, 0, 0, 0, 0]);
    expect(feed(rounds).pressure).toBe('calm');
  });

  /*
   * The positive control. Without it the two cases above pass just as well
   * when the feature has stopped working altogether — which is the shape this
   * project has been caught by before.
   */
  it('quiets the chrome for sustained pressure', () => {
    expect(feed(Array.from({ length: LIMITS.highSamples }, () => ONE_ROUND)).pressure).toBe('high');
  });

  it('waits for the whole run, and not one sample less', () => {
    const short = Array.from({ length: LIMITS.highSamples - 1 }, () => ONE_ROUND);
    expect(feed(short).pressure).toBe('calm');
  });

  it('relaxes only after a full run of calm samples', () => {
    const busy = Array.from({ length: LIMITS.highSamples }, () => ONE_ROUND);
    const settling = Array.from({ length: LIMITS.calmSamples - 1 }, () => 0);
    expect(feed([...busy, ...settling]).pressure).toBe('high');
    expect(feed([...busy, ...settling, 0]).pressure).toBe('calm');
  });

  /*
   * What makes this hysteresis rather than two counters kept side by side. A
   * stream that crosses the line every other sample is not sustained pressure
   * and must not accumulate towards it — nor, once high, towards relaxing.
   */
  it('lets each edge reset the other run', () => {
    const alternating = Array.from({ length: 20 }).flatMap(() => [ONE_ROUND, 0]);
    expect(feed(alternating).pressure).toBe('calm');

    const busy = Array.from({ length: LIMITS.highSamples }, () => ONE_ROUND);
    const flickering = Array.from({ length: 20 }).flatMap(() => [0, ONE_ROUND]);
    expect(feed([...busy, ...flickering]).pressure).toBe('high');
  });

  it('reads the water line as inclusive', () => {
    const atTheLine = Array.from({ length: LIMITS.highSamples }, () => LIMITS.highWater);
    expect(feed(atTheLine).pressure).toBe('high');

    const justUnder = Array.from({ length: LIMITS.highSamples }, () => LIMITS.highWater - 1);
    expect(feed(justUnder).pressure).toBe('calm');
  });

  /*
   * A run of one is the old behaviour, and somebody who wants it back can have
   * it from `internal.yaml` without a rebuild — which is the reason the number
   * is a tuning key rather than a constant beside the code.
   */
  it('honours a run of one, which is what it used to do', () => {
    expect(feed([ONE_ROUND], { ...LIMITS, highSamples: 1 }).pressure).toBe('high');
  });
});
