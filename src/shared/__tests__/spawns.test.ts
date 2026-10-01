import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../character';
import {
  RefillWatch,
  learnRefill,
  refillClock,
  refillCount,
  usualClock,
  type LearnedSpawns
} from '../spawns';
import type { WorldLair } from '../world';

const one = (name: string, kind: RoomOccupant['kind']): RoomOccupant =>
  ({ name, kind }) as RoomOccupant;

function standing(
  number: number,
  names: string[],
  lair: string[] = [],
  unplaced: string[] = []
): CharacterState {
  return {
    ...EMPTY_CHARACTER,
    room: {
      ...EMPTY_CHARACTER.room,
      map: 1,
      number,
      occupants: [
        ...names.map((name) => one(name, 'mob')),
        ...unplaced.map((name) => one(name, 'unknown')),
        one('Soul', 'player')
      ],
      lair:
        lair.length === 0
          ? null
          : ({ max: 1, respawnSeconds: null, mobs: lair.map((n) => ({ name: n })) } as WorldLair)
    }
  };
}

describe('timing a room’s refill', () => {
  it('times the kill that emptied the room to the next monster in', () => {
    const watch = new RefillWatch();
    const bear = refillCount(standing(2156, ['cave bear'], ['cave bear']));
    expect(watch.observe(bear, 0, false)).toBeNull();
    expect(watch.observe(refillCount(standing(2156, [], ['cave bear'])), 1_000, true)).toBeNull();
    expect(watch.observe(bear, 33_000, false)).toEqual({
      room: '1/2156',
      seconds: 32,
      names: ['cave bear']
    });
  });

  it('times nothing when the room emptied by a monster walking out', () => {
    const watch = new RefillWatch();
    watch.observe(refillCount(standing(1, ['orc'])), 0, false);
    watch.observe(refillCount(standing(1, [])), 1_000, false);
    expect(watch.observe(refillCount(standing(1, ['orc'])), 5_000, false)).toBeNull();
  });

  it('drops the clock while something nobody has placed stands in the room', () => {
    const watch = new RefillWatch();
    watch.observe(refillCount(standing(1, ['orc'])), 0, false);
    watch.observe(refillCount(standing(1, [], [], ['Grimble'])), 1_000, true);
    watch.observe(refillCount(standing(1, [])), 2_000, false);
    expect(watch.observe(refillCount(standing(1, ['orc'])), 5_000, false)).toBeNull();
  });

  it('drops the clock on leaving, since walking back in refills the room', () => {
    const watch = new RefillWatch();
    watch.observe(refillCount(standing(2156, ['cave bear'], ['cave bear'])), 0, false);
    watch.observe(refillCount(standing(2156, [], ['cave bear'])), 1_000, true);
    watch.observe(refillCount(standing(2152, [])), 2_000, false);
    expect(
      watch.observe(refillCount(standing(2156, ['cave bear'], ['cave bear'])), 9_000, false)
    ).toBeNull();
  });

  it('counts only the lair’s own monsters where the realm states a lair', () => {
    const counted = refillCount(standing(2152, ['big giant rat', 'orc'], ['giant rat']));
    expect(counted).toEqual({ room: '1/2152', names: ['big giant rat'], unsure: false });
    // And every monster where it states none: an arena.
    expect(refillCount(standing(2150, ['filthbug', 'acid slime']))?.names).toHaveLength(2);
  });

  it('prices a room only once it has refilled often enough, on the median', () => {
    let entry: LearnedSpawns | undefined;
    for (const seconds of [40, 20]) entry = learnRefill(entry, { seconds, names: ['rat'] }, 1, 12);
    expect(refillClock(entry, 3)).toBeNull();
    entry = learnRefill(entry, { seconds: 30, names: ['rat'] }, 2, 12);
    expect(refillClock(entry, 3)).toBe(30);
    expect(entry.seen).toEqual({ rat: 3 });
    expect(learnRefill(entry, { seconds: 5, names: [] }, 3, 2).refills).toEqual([30, 5]);
  });

  it('reads the realm’s usual clock over every room that has one', () => {
    const room = (refills: number[]): LearnedSpawns => ({ refills, seen: {}, at: 0 });
    expect(usualClock([room([30, 30, 30]), room([60, 60, 60]), room([1])], 3)).toBe(45);
    expect(usualClock([room([1])], 3)).toBeNull();
  });
});
