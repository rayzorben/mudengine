import { describe, expect, it } from 'vitest';

import { huntingRooms, movedTo, type HuntingMoved } from '../huntReply';
import type { HuntingAdvice, HuntingRoom, HuntingSpot } from '../hunting';

/*
 * The card puts a `same` answer's steps on the survey it holds (todo
 * 20261102-2305-02), so what it draws is the survey with the steps from
 * where the character stands, and nothing is redrawn where none moved.
 */

const room = (id: string, steps: number): HuntingRoom => ({
  id,
  map: 1,
  room: Number(id.split('/')[1]),
  name: id,
  steps
});

const spot = (key: string, rooms: HuntingRoom[], filler: HuntingRoom[] = []): HuntingSpot =>
  ({ key, rooms, filler, walk: [...rooms, ...filler] }) as unknown as HuntingSpot;

const ADVICE = {
  from: { id: '1/1', name: 'Town Square' },
  swept: 6,
  spots: [spot('goblin', [room('1/2', 1), room('1/3', 2)], [room('1/5', 4)])],
  unmeasured: [spot('orc', [room('1/3', 2), room('1/4', 3)])],
  gated: []
} as unknown as HuntingAdvice;

describe('a survey moved to where the character stands', () => {
  it('names each room once, the spots first', () => {
    expect(huntingRooms(ADVICE)).toEqual(['1/2', '1/3', '1/5', '1/4']);
  });

  it('carries the new steps on every list a room is in', () => {
    const moved: HuntingMoved = {
      from: { id: '1/2', name: '1/2' },
      swept: 6,
      gated: [],
      steps: [0, 1, 3, 2]
    };
    const next = movedTo(ADVICE, moved);
    expect(next).not.toBe(ADVICE);
    expect(next?.from).toEqual(moved.from);
    expect(next?.spots[0]?.rooms.map((each) => each.steps)).toEqual([0, 1]);
    expect(next?.spots[0]?.walk.map((each) => each.steps)).toEqual([0, 1, 3]);
    expect(next?.spots[0]?.filler.map((each) => each.steps)).toEqual([3]);
    expect(next?.unmeasured[0]?.rooms.map((each) => each.steps)).toEqual([1, 2]);
    // Everything but the steps is the survey held.
    expect(next?.spots[0]?.key).toBe('goblin');
  });

  // The positive control is the case above, where the same call did redraw.
  it('is the same survey where nothing it draws moved', () => {
    const still: HuntingMoved = {
      from: ADVICE.from,
      swept: 6,
      gated: [],
      steps: [1, 2, 4, 3]
    };
    expect(movedTo(ADVICE, still)).toBe(ADVICE);
  });

  it('is nothing for steps that are not this survey’s rooms', () => {
    const other: HuntingMoved = { from: ADVICE.from, swept: 6, gated: [], steps: [1, 2] };
    expect(movedTo(ADVICE, other)).toBeNull();
  });
});
