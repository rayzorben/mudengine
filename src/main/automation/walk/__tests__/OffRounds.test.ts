import { describe, expect, it, vi } from 'vitest';

import { offRoundHoldMs } from '../OffRounds';
import { t } from '../../../app/i18n';
import { EMPTY_CHARACTER } from '../../../../shared/character';
import { DEFAULT_INTERNAL } from '../../../../shared/internal';
import { at, moves, routeOf, stepOf, useRigs, wire } from './walking';

const TUNING = DEFAULT_INTERNAL.tuning;
const MARGIN = TUNING.walk.offRoundMarginMs;

/*
 * Figures measured 2026-10-03 on Paradigm: a round every 5,037 ms (median of
 * 17,722 gaps), a step answered in 1,239 ms unladen (festus, 2026-09-02) and
 * 1,854 ms carrying a loop's loot (median of 13,228 steps).
 */
describe('how long a step out of an empty room is held', () => {
  const round = 10_000;

  it('is nothing where the step lands well before the round', () => {
    expect(offRoundHoldMs(round - 5037 + 300, round, 1239, MARGIN)).toBe(0);
  });

  it('is nothing where the step lands after the round anyway', () => {
    // The character stays in the empty room through the server's move delay.
    expect(offRoundHoldMs(round - 1239 + MARGIN + 1, round, 1239, MARGIN)).toBe(0);
  });

  it('moves a step landing just before the round to just after it', () => {
    const now = round - 1854 - 100;
    const hold = offRoundHoldMs(now, round, 1854, MARGIN);
    expect(now + hold + 1854).toBe(round + MARGIN);
  });

  it('moves a step landing just after the round to the margin', () => {
    const now = round - 1854 + 100;
    expect(offRoundHoldMs(now, round, 1854, MARGIN)).toBe(MARGIN - 100);
  });
});

describe('a run timed to the rounds', () => {
  const rigOf = useRigs();
  const STEP = 1239;
  /** Six rooms in a line, 1/1 east to 1/6. */
  const LINE = routeOf(...[1, 2, 3, 4, 5].map((room) => stepOf(room, room + 1, 'e')));
  /** The captured rounds' gaps (festus, t=956178): 5052, 5052, 5030. */
  const ROUNDS = [0, 5052, 10104, 15134];
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

  /**
   * The rounds of a fight, then a walk whose first three steps are answered
   * in `STEP` each: the arrival in 1/4 is at 18,951, and a step from there
   * would land at 20,190, four milliseconds after the round at 20,186.
   */
  function walkToRoomFour(run: boolean, roomFour = at(1, 4)) {
    vi.setSystemTime(base);
    const rig = rigOf();
    for (const round of ROUNDS) {
      vi.setSystemTime(base + round);
      rig.walker.onBlock(wire('mob-hits'));
    }
    vi.setSystemTime(base + 15234);
    rig.walker.start(LINE, at(1, 1), { offRounds: run });
    for (const room of [2, 3]) {
      vi.advanceTimersByTime(STEP);
      rig.walker.onCharacter(at(1, room));
    }
    vi.advanceTimersByTime(STEP);
    rig.walker.onCharacter(roomFour);
    expect(Date.now()).toBe(base + 18951);
    return rig;
  }

  it('holds the step so it lands just after the round', () => {
    const rig = walkToRoomFour(true);
    expect(moves(rig.sent)).toEqual(['e', 'e', 'e']);
    vi.advanceTimersByTime(20186 + MARGIN - STEP - 18951 - 1);
    expect(moves(rig.sent)).toEqual(['e', 'e', 'e']);
    vi.advanceTimersByTime(1);
    expect(moves(rig.sent)).toEqual(['e', 'e', 'e', 'e']);
    expect(rig.notices).toContain(
      t('automation.walk.offRoundsTimed', { round: '5.05', step: '1.24' })
    );
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
      t('automation.walk.offRoundsTimed', { round: '5.05', step: '1.24' })
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
