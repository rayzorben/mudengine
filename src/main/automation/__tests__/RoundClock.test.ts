import { describe, expect, it } from 'vitest';

import { RoundClock, fitBeat } from '../RoundClock';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { blockOf } from '../../../shared/__tests__/blocks';

const TUNING = DEFAULT_INTERNAL.tuning;
const NOMINAL = TUNING.hunting.roundSeconds * 1000;

/*
 * The rounds of one fight, as the capture has them
 * (`2026-10-03_17-51-16_festus.mudcap.jsonl`, t=956178, festus against a
 * vampire bat on Paradigm): gaps of 5,020-5,052 ms, then one of 4,030 ms.
 * Over the whole session the rounds keep a beat of 4,999.9 ms.
 */
const ROUNDS = [956178, 961230, 966282, 971312, 976346, 981366, 985396];

/** A round's first blow lands up to half a second either side of the beat. */
const JITTER = [310, -420, 120, 470, -260, 40, -480, 200, -90, 380, -330, 0];

/** `count` rounds on a beat of `periodMs` from `zero`, every `every`th round seen, with jitter. */
function beat(zero: number, periodMs: number, count: number, every = 1): number[] {
  return Array.from(
    { length: count },
    (_, i) => zero + i * every * periodMs + JITTER[i % JITTER.length]!
  );
}

function clockOver(rounds: readonly number[]): RoundClock {
  const clock = new RoundClock();
  for (const at of rounds) clock.onBlock(blockOf('user-hits', '', {}, at));
  return clock;
}

function nextAt(clock: RoundClock, now: number): number {
  const next = clock.next(now);
  if (!next.known) throw new Error('no round known');
  return next.at;
}

describe('the next round', () => {
  it('is unknown until a round is seen', () => {
    expect(new RoundClock().next(1000)).toEqual({ known: false });
  });

  it('is a nominal round on from the only round seen', () => {
    expect(clockOver([10_000]).next(10_100)).toEqual({
      known: true,
      at: 10_000 + NOMINAL,
      periodMs: NOMINAL
    });
  });

  it('keeps the nominal period over one fight, and averages its rounds for the phase', () => {
    const clock = clockOver(beat(100_000, NOMINAL, 6));
    const late = JITTER.slice(0, 6).reduce((a, b) => a + b, 0) / 6;
    expect(clock.next(100_000 + 5.5 * NOMINAL)).toEqual({
      known: true,
      at: expect.closeTo(100_000 + 6 * NOMINAL + late, 6),
      periodMs: NOMINAL
    });
  });

  it('takes the 4 s gap a capture showed as the blows catching up with the beat', () => {
    // Each round's blows came about 37 ms later than the last until one came
    // a tick early; the next round is on the beat.
    const due = 956178 + 7 * NOMINAL;
    expect(Math.abs(nextAt(clockOver(ROUNDS), 985396 + 100) - due)).toBeLessThan(100);
  });

  it('learns the server period from many rounds and holds it for minutes with none seen', () => {
    const period = 5000.1;
    const rounds = beat(1_000_000, period, 120, 3);
    const clock = clockOver(rounds);
    expect(clock.next(rounds.at(-1)!)).toMatchObject({
      known: true,
      periodMs: expect.closeTo(period, 0)
    });
    // Seven and a half minutes on, festus's walk of 2026-10-05.
    const due = 1_000_000 + 450 * period;
    expect(Math.abs(nextAt(clock, due - 1000) - due)).toBeLessThan(100);
  });

  it('starts a new beat after rounds off the old one in a row', () => {
    const shifted = 200_000 + 2500;
    const clock = clockOver([
      ...beat(100_000, NOMINAL, 6),
      ...beat(shifted, NOMINAL, TUNING.combat.offBeatRounds)
    ]);
    const after = shifted + TUNING.combat.offBeatRounds * NOMINAL;
    expect(Math.abs(nextAt(clock, after - 1000) - after)).toBeLessThan(500);
  });

  it('leaves a single round off the beat out', () => {
    const rounds = beat(100_000, NOMINAL, 6);
    const clock = clockOver([...rounds, rounds.at(-1)! + 2600]);
    expect(nextAt(clock, rounds.at(-1)! + 3000)).toBe(
      nextAt(clockOver(rounds), rounds.at(-1)! + 3000)
    );
  });

  it('forgets everything on a new connection', () => {
    const clock = clockOver(ROUNDS);
    clock.reset();
    expect(clock.next(985396 + 100)).toEqual({ known: false });
  });
});

describe('fitBeat', () => {
  it('keeps the nominal period while the fitted one is unsure', () => {
    const seen = [0, 5300, 9800].map((at, n) => ({ at, n }));
    expect(fitBeat(seen, NOMINAL, 1).periodMs).toBe(NOMINAL);
  });

  it('takes the fitted period once it is sure', () => {
    const seen = Array.from({ length: 50 }, (_, n) => ({ at: 7 + n * 5003, n }));
    expect(fitBeat(seen, NOMINAL, 1)).toEqual({
      zero: expect.closeTo(7, 6),
      periodMs: expect.closeTo(5003, 6)
    });
  });
});

describe('a realm that runs faster', () => {
  /* orohost runs at 5 (`GameSpeed`): a round a second, numbered on the realm's beat. */
  it('numbers the rounds of a realm that runs faster on its own beat', () => {
    const fast = Array.from({ length: 40 }, (_, i) => 100_000 + i * 1000 + ((i % 3) - 1) * 60);
    const clock = new RoundClock(() => 5);
    for (const at of fast) clock.onBlock(blockOf('user-hits', '', {}, at));
    const next = clock.next(fast.at(-1)! + 10);
    expect(next.known && next.periodMs).toBeCloseTo(1000, -1);
    // The next round falls on the fitted beat whatever the last blow's jitter.
    expect(nextAt(clock, fast.at(-1)! + 10)).toBeCloseTo(140_000, -2);
  });
});
