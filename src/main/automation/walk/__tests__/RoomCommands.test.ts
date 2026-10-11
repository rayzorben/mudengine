import { describe, expect, it, vi } from 'vitest';

import { t } from '../../../app/i18n';
import type { CharacterState, RoomOccupant } from '../../../../shared/character';
import { DEFAULT_INTERNAL } from '../../../../shared/internal';
import type { RoomId } from '../../../../shared/world';
import { at, moves, routeOf, stepOf, wire, useRigs } from './walking';

/*
 * A room command's own check refusing the step (todo 65): once more after a
 * beat, then the way written down and the journey planned again. Each test is
 * red under the mutation named beside it.
 */

const TUNING = DEFAULT_INTERNAL.tuning;
const walkerOn = useRigs();

/** `go hole` out of 1/1, which the realm runs only with no monster in the room. */
const HOLE = routeOf(
  stepOf(1, 2, 'e', {
    direction: 'portal',
    command: 'go hole',
    requirement: { kind: 'text', raw: 'go hole', gates: [{ kind: 'empty-room' }] }
  })
);

/** The same way behind a level check, which answers the same a moment later. */
const LEVELLED = routeOf(
  stepOf(1, 2, 'e', {
    direction: 'portal',
    command: 'go hole',
    requirement: { kind: 'text', raw: 'go hole', gates: [{ kind: 'level', min: 5 }] }
  })
);

const monster: RoomOccupant = {
  name: 'cave worm',
  kind: 'mob',
  disposition: null,
  uncertain: false,
  costly: 'never',
  charmed: false,
  hidden: false,
  free: false
};

const withWorm = (): CharacterState =>
  at(1, 1, { room: { ...at(1, 1).room, occupants: [monster] } });

/** What the session is told: the way written down, and each replan asked for. */
function recorder() {
  const seen = { refused: [] as Array<[RoomId, string, string]>, replans: 0 };
  const events = {
    refused: (
      from: RoomId,
      direction: string,
      why: 'missing' | 'shut' | 'checked' | 'for-now'
    ): void => {
      seen.refused.push([from, direction, why]);
    },
    replan: (): string => {
      seen.replans += 1;
      return 'no other way';
    }
  };
  return Object.assign(seen, { events });
}

describe('a room command its check refuses', () => {
  // Mutant: the refusal off the wire not read; the second refusal retried again.
  it('sends it once more, then writes the way down and plans again', () => {
    const calm = at(1, 1);
    const seen = recorder();
    const { walker, sent, notices } = walkerOn({ ...seen.events, stateNow: () => calm });
    walker.start(HOLE, calm);
    vi.advanceTimersByTime(50);
    expect(moves(sent)).toEqual(['go hole']);

    walker.onBlock(wire('room-command-refused'));
    expect(notices).toContain(t('automation.walk.roomCommandRetry', { command: 'go hole' }));
    vi.advanceTimersByTime(TUNING.walk.holdMs + 50);
    expect(moves(sent)).toEqual(['go hole', 'go hole']);

    walker.onBlock(wire('room-command-refused'));
    expect(seen.refused).toEqual([['1/1', 'portal', 'for-now']]);
    expect(seen.replans).toBe(1);
  });

  // Mutant: `refuseBeforeSending` reading nothing.
  it('does not send into a room a monster still stands in', () => {
    const occupied = withWorm();
    const seen = recorder();
    const { walker, sent } = walkerOn({ ...seen.events, stateNow: () => occupied });
    walker.start(HOLE, occupied);
    vi.advanceTimersByTime(TUNING.walk.holdMs + 50);
    expect(moves(sent)).toEqual([]);
    expect(seen.refused).toEqual([['1/1', 'portal', 'for-now']]);

    // Positive control: the same step from an empty room goes out.
    const calm = at(1, 1);
    const other = walkerOn({ ...recorder().events, stateNow: () => calm });
    other.walker.start(HOLE, calm);
    vi.advanceTimersByTime(50);
    expect(moves(other.sent)).toEqual(['go hole']);
  });

  // Mutant: every gated room command retried, whatever its check.
  it('gives a level check up on its first refusal', () => {
    const calm = at(1, 1);
    const seen = recorder();
    const { walker, sent } = walkerOn({ ...seen.events, stateNow: () => calm });
    walker.start(LEVELLED, calm);
    vi.advanceTimersByTime(50);
    expect(moves(sent)).toEqual(['go hole']);
    walker.onBlock(wire('room-command-refused'));
    expect(seen.refused).toEqual([['1/1', 'portal', 'checked']]);
    expect(seen.replans).toBe(1);
    vi.advanceTimersByTime(TUNING.walk.holdMs + 50);
    expect(moves(sent)).toEqual(['go hole']);
  });

  // Mutant: the deadline read as a plain timeout for a gated room command.
  it('reads a bare prompt at the deadline as the check refusing', () => {
    const calm = at(1, 1);
    const seen = recorder();
    const { walker, ends, sent } = walkerOn({ ...seen.events, stateNow: () => calm });
    walker.start(HOLE, calm);
    vi.advanceTimersByTime(50);
    walker.onCharacter(calm);
    // Two deadlines, each behind its nudge: the step, once more, then the way given up.
    vi.advanceTimersByTime(30_000);
    expect(moves(sent)).toEqual(['go hole', 'go hole']);
    expect(
      ends.some(([, why]) => why === t('automation.walk.reasonTimeout', { command: 'go hole' }))
    ).toBe(false);
    expect(seen.refused).toEqual([['1/1', 'portal', 'for-now']]);
  });
});
