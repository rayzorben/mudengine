import { describe, expect, it, vi } from 'vitest';

import { OffRounds, offRoundHoldMs } from '../OffRounds';
import { StepTimes } from '../StepTimes';
import { blockOf } from '../../../../shared/__tests__/blocks';
import { t } from '../../../app/i18n';
import { EMPTY_CHARACTER } from '../../../../shared/character';
import { DEFAULT_INTERNAL } from '../../../../shared/internal';
import { at, configWith, moves, routeOf, stepOf, useRigs, wire } from './walking';

const TUNING = DEFAULT_INTERNAL.tuning;
const MARGIN = TUNING.walk.offRoundMarginMs;
const ON = { runBetweenRounds: true };
/** A step into a room the realm marks as a lair. */
const INTO_LAIR = stepOf(1, 2, 'e', { lair: true });

/*
 * Figures measured 2026-10-03 on Paradigm: a round every 5,037 ms (median of
 * 17,722 gaps), a step answered in 1,239 ms unladen (festus, 2026-09-02) and
 * 1,854 ms carrying a loop's loot (median of 13,228 steps).
 */
describe('how long a step out of an empty room is held', () => {
  const round = 10_000;
  const period = 5037;

  it('is nothing while two steps fit before the round', () => {
    expect(offRoundHoldMs(round - 2 * 1239 - MARGIN - 1, round, period, 1239, MARGIN)).toBe(0);
  });

  it('is until the round where they do not', () => {
    const now = round - 2 * 1239 - MARGIN;
    expect(offRoundHoldMs(now, round, period, 1239, MARGIN)).toBe(round - now);
  });

  it('is nothing as the round goes off', () => {
    expect(offRoundHoldMs(round - period, round, period, 1854, MARGIN)).toBe(0);
    expect(offRoundHoldMs(round - period + MARGIN, round, period, 1854, MARGIN)).toBe(0);
  });

  it('is nothing as the round goes off when two steps never fit in one', () => {
    // A laden step of 2.6 s: one step a round, sent as the round fires.
    expect(offRoundHoldMs(round - period, round, period, 2600, MARGIN)).toBe(0);
    expect(offRoundHoldMs(round - period + MARGIN + 1, round, period, 2600, MARGIN)).toBe(
      period - MARGIN - 1
    );
  });
});

describe('a held step', () => {
  it('goes when its timer fires late, rather than holding another round', () => {
    let now = 0;
    const steps = new StepTimes();
    for (let i = 0; i < TUNING.walk.offRoundStepSamples; i += 1) {
      steps.sent(0);
      steps.answered(2600);
    }
    const offRounds = new OffRounds(steps, {}, () => now);
    offRounds.onBlock(blockOf('mob-hits', '', {}, 0));
    offRounds.begin(true);
    now = 4000;
    expect(offRounds.holdMs(at(1, 1), INTO_LAIR, ON, true)).toBe(1000);
    // A step too long to fit twice, and the retry comes half a second after the round.
    now = 5500;
    expect(offRounds.holdMs(at(1, 1), INTO_LAIR, ON, true)).toBe(0);
  });
});

describe('a run timed to the rounds', () => {
  const rigOf = useRigs();
  const STEP = 1239;
  /** Six rooms in a line, 1/1 east to 1/6, each a lair. */
  const LINE = routeOf(
    ...[1, 2, 3, 4, 5].map((room) => stepOf(room, room + 1, 'e', { lair: true }))
  );
  /** The same line with no lair in it. */
  const TOWN = routeOf(...[1, 2, 3, 4, 5].map((room) => stepOf(room, room + 1, 'e')));
  /** A fight's rounds on Paradigm's beat of 5,000 ms. */
  const ROUNDS = [0, 5000, 10000, 15000];
  const base = 1_000_000;

  const monster = {
    name: 'vampire bat',
    kind: 'mob' as const,
    disposition: 'hostile' as const,
    uncertain: false,
    costly: 'never' as const,
    hidden: false,
    free: false,
    charmed: false
  };

  const PERIOD = 5000;

  /**
   * The rounds of a fight, then a walk started `roundsLater` rounds on whose
   * first three steps are answered in `STEP` each: the arrival in 1/4 is
   * 1,049 ms before a round, too soon for two steps.
   */
  function walkToRoomFour(
    run: boolean,
    roomFour = at(1, 4),
    roundsLater = 0,
    { line = LINE, runBetweenRounds = true } = {}
  ) {
    vi.setSystemTime(base);
    const rig = rigOf({}, configWith({ movement: { runBetweenRounds } }));
    for (const round of ROUNDS) {
      vi.setSystemTime(base + round);
      rig.walker.onBlock(wire('mob-hits'));
    }
    vi.setSystemTime(base + 15234 + roundsLater * PERIOD);
    rig.walker.start(line, at(1, 1), { offRounds: run });
    for (const room of [2, 3]) {
      vi.advanceTimersByTime(STEP);
      rig.walker.onCharacter(at(1, room));
    }
    vi.advanceTimersByTime(STEP);
    rig.walker.onCharacter(roomFour);
    expect(Date.now()).toBe(base + 18951 + roundsLater * PERIOD);
    return rig;
  }

  function heldUntilTheRound(rig: ReturnType<typeof walkToRoomFour>): void {
    expect(moves(rig.sent)).toEqual(['e', 'e', 'e']);
    vi.advanceTimersByTime(1049 - 1);
    expect(moves(rig.sent)).toEqual(['e', 'e', 'e']);
    vi.advanceTimersByTime(1);
    expect(moves(rig.sent)).toEqual(['e', 'e', 'e', 'e']);
  }

  it('holds the step until the round goes off', () => {
    const rig = walkToRoomFour(true);
    heldUntilTheRound(rig);
    expect(rig.notices).toContain(
      t('automation.walk.offRoundsTimed', { round: '5.00', step: '1.24' })
    );
  });

  it('steps again at once where two steps fit before the next round', () => {
    const rig = walkToRoomFour(true);
    heldUntilTheRound(rig);
    vi.advanceTimersByTime(STEP);
    rig.walker.onCharacter(at(1, 5));
    expect(moves(rig.sent)).toEqual(['e', 'e', 'e', 'e', 'e']);
  });

  it('steps at once when a monster comes in while the step is held', () => {
    const rig = walkToRoomFour(true);
    expect(moves(rig.sent)).toEqual(['e', 'e', 'e']);
    rig.walker.onCharacter(
      at(1, 4, {
        room: { ...structuredClone(EMPTY_CHARACTER.room), map: 1, number: 4, occupants: [monster] }
      })
    );
    expect(moves(rig.sent)).toEqual(['e', 'e', 'e', 'e']);
  });

  it('times nothing into a room with no lair', () => {
    const rig = walkToRoomFour(true, at(1, 4), 0, { line: TOWN });
    expect(moves(rig.sent)).toEqual(['e', 'e', 'e', 'e']);
  });

  it('times nothing with the switch off', () => {
    const rig = walkToRoomFour(true, at(1, 4), 0, { runBetweenRounds: false });
    expect(moves(rig.sent)).toEqual(['e', 'e', 'e', 'e']);
  });

  it('counts on from the last round seen, however long ago', () => {
    heldUntilTheRound(walkToRoomFour(true, at(1, 4), 20));
  });

  it('steps at once out of a room with a monster in it', () => {
    const roomFour = at(1, 4, {
      room: { ...structuredClone(EMPTY_CHARACTER.room), map: 1, number: 4, occupants: [monster] }
    });
    const rig = walkToRoomFour(true, roomFour);
    expect(moves(rig.sent)).toEqual(['e', 'e', 'e', 'e']);
  });

  it('times nothing on a walk that is not a run', () => {
    const rig = walkToRoomFour(false);
    expect(moves(rig.sent)).toEqual(['e', 'e', 'e', 'e']);
    expect(rig.notices).not.toContain(
      t('automation.walk.offRoundsTimed', { round: '5.00', step: '1.24' })
    );
  });

  it('runs untimed and says why while the steps are not measured', () => {
    vi.setSystemTime(base);
    const rig = rigOf();
    for (const round of ROUNDS) {
      vi.setSystemTime(base + round);
      rig.walker.onBlock(wire('mob-hits'));
    }
    rig.walker.start(LINE, at(1, 1), { offRounds: true });
    vi.advanceTimersByTime(STEP);
    rig.walker.onCharacter(at(1, 2));
    expect(moves(rig.sent)).toEqual(['e', 'e']);
    const untimed = t('automation.walk.offRoundsNoSteps');
    expect(rig.notices.filter((notice) => notice === untimed)).toHaveLength(1);
  });
});
