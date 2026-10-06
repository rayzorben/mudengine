import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../character';
import {
  RefillWatch,
  learnRefill,
  refillClock,
  refillCount,
  SPAWNS_VERSION,
  timedWithMoves,
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
      names: ['cave bear'],
      lair: true
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

  /* 2026-10-06: the server spawns the room walked into before it prints it, and Slum Street, Bend was priced as refilling every half second. */
  it('times nothing that arrives while a move is unanswered: the arrival is the next room’s', () => {
    const watch = new RefillWatch();
    watch.observe(refillCount(standing(1197, ['orc rogue'])), 0, false);
    watch.observe(refillCount(standing(1197, [])), 1_000, true);
    expect(
      watch.observe(refillCount(standing(1197, ['thin orc rogue'])), 1_500, false, true)
    ).toBeNull();
    // And the clock went with it: the room standing empty again times nothing either.
    watch.observe(refillCount(standing(1197, [])), 2_000, false);
    expect(watch.observe(refillCount(standing(1197, ['orc rogue'])), 9_000, false)).toBeNull();
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
    expect(counted).toEqual({
      room: '1/2152',
      names: ['big giant rat'],
      lair: true,
      unsure: false
    });
    // And every monster where it states none: an arena.
    expect(refillCount(standing(2150, ['filthbug', 'acid slime']))).toMatchObject({
      names: ['filthbug', 'acid slime'],
      lair: false
    });
  });

  it('prices a room only once it has refilled often enough, on the median', () => {
    let entry: LearnedSpawns | undefined;
    for (const seconds of [40, 20])
      entry = learnRefill(entry, { seconds, names: ['rat'], lair: true }, 1, 12, 3);
    expect(refillClock(entry, 3)).toBeNull();
    entry = learnRefill(entry, { seconds: 30, names: ['rat'], lair: true }, 2, 12, 3);
    expect(refillClock(entry, 3)).toBe(30);
    expect(entry.seen).toEqual({ rat: 3 });
    expect(learnRefill(entry, { seconds: 5, names: [], lair: true }, 3, 2, 3).refills).toEqual([
      30, 5
    ]);
  });

  /* A lair's clock stands on its gaps over the floor, so starting afresh keeps those. */
  it('starts a lair’s entry timed before moves were accounted for afresh, over the floor, and stamps it', () => {
    const old: LearnedSpawns = { refills: [0.5, 69, 0.6, 71], seen: { 'orc rogue': 3 }, at: 0 };
    expect(timedWithMoves(old)).toBe(false);
    const learned = learnRefill(
      old,
      { seconds: 70, names: ['carrion beast'], lair: true },
      1,
      12,
      3
    );
    expect(learned).toEqual({
      refills: [69, 71, 70],
      seen: { 'carrion beast': 1 },
      at: 1,
      v: SPAWNS_VERSION
    });
    expect(timedWithMoves(learned)).toBe(true);
    // Once stamped, every gap it times is kept, under the floor or not.
    expect(learnRefill(learned, { seconds: 0.4, names: [], lair: true }, 2, 12, 3).refills).toEqual(
      [69, 71, 70, 0.4]
    );
  });

  /* Outside a lair the next room's spawn lands over the floor too: Crypt, Stone Hallway's 5.8, 4.8 and 3.4 s. */
  it('starts any other room’s old entry with nothing kept', () => {
    const old: LearnedSpawns = { refills: [5.8, 3.4, 4.8], seen: { zombie: 3 }, at: 0 };
    expect(
      learnRefill(old, { seconds: 60, names: ['bat'], lair: false }, 1, 12, 3).refills
    ).toEqual([60]);
  });

  it('counts no gap under the shortest as a refill', () => {
    const room = (refills: number[]): LearnedSpawns => ({ refills, seen: {}, at: 0 });
    // orohost's record: a room read empty and full again within a second, now and then a real one.
    const reread = room([0.55, 0.6, 0.57, 0.6, 22, 0.58, 21, 0.6, 23]);
    expect(refillClock(reread, 3)).toBeCloseTo(0.6);
    expect(refillClock(reread, 3, 3)).toBe(22);
    expect(usualClock([room([0.5, 0.6, 0.55]), room([69, 70, 68])], 3, 3)).toBe(69);
  });

  it('reads the realm’s usual clock over every room that has one', () => {
    const room = (refills: number[]): LearnedSpawns => ({ refills, seen: {}, at: 0 });
    expect(usualClock([room([30, 30, 30]), room([60, 60, 60]), room([1])], 3)).toBe(45);
    expect(usualClock([room([1])], 3)).toBeNull();
  });
});
