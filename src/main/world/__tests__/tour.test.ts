import { describe, expect, it } from 'vitest';

import { tour, type TourWorld } from '../navigation/tour';
import type { RoomId } from '../../../shared/world';

/** Rooms on one corridor, `1/0` to `1/9`: a move between neighbours, and a lair at `1/5` priced dear. */
const corridor: TourWorld = {
  sweepTo(from, rooms) {
    const at = (room: RoomId): number => Number(room.split('/')[1]);
    const found = new Map<RoomId, { cost: number; moves: number }>();
    for (const room of rooms) {
      if (!/^1\/\d$/.test(room)) continue;
      const moves = Math.abs(at(room) - at(from));
      const crossesLair = Math.min(at(room), at(from)) < 5 && Math.max(at(room), at(from)) >= 5;
      found.set(room, { moves, cost: moves + (crossesLair ? 100 : 0) });
    }
    return found;
  }
};

const ask = (things: RoomId[][], over: Partial<Parameters<typeof tour>[2]> = {}) =>
  tour(
    corridor,
    '1/0' as RoomId,
    { things, places: 3, exact: 10, end: null, by: 'moves', ...over },
    {}
  );

describe('the order to fetch several things in', () => {
  it('walks out along the corridor rather than back and forth', () => {
    const answer = ask([['1/7'], ['1/2'], ['1/4']] as RoomId[][]);
    expect(answer?.stops.map((stop) => stop.room)).toEqual(['1/2', '1/4', '1/7']);
    expect(answer?.stops.map((stop) => stop.moves)).toEqual([2, 2, 3]);
  });

  it('picks the nearer of the places a thing is got in', () => {
    const answer = ask([['1/8', '1/3'], ['1/4']] as RoomId[][]);
    expect(answer?.stops.map((stop) => stop.room)).toEqual(['1/3', '1/4']);
  });

  it('visits what every other thing waits on first', () => {
    const answer = ask([['1/6'], ['1/2']] as RoomId[][], { first: new Set([0]) });
    expect(answer?.stops.map((stop) => stop.thing)).toEqual([0, 1]);
  });

  it('says which things no place of reaches, and orders the rest', () => {
    const answer = ask([['9/9'], ['1/1']] as RoomId[][]);
    expect(answer?.unreached).toEqual([0]);
    expect(answer?.stops.map((stop) => stop.room)).toEqual(['1/1']);
  });

  it('weighs the router cost when asked to, and moves alone when asked to', () => {
    const from = '1/4' as RoomId;
    const things = [['1/5', '1/1']] as RoomId[][];
    const by = (weigh: 'cost' | 'moves') =>
      tour(corridor, from, { things, places: 3, exact: 10, end: null, by: weigh }, {})?.stops[0]
        ?.room;
    // One step into the lair, or three steps the other way.
    expect(by('moves')).toBe('1/5');
    expect(by('cost')).toBe('1/1');
  });

  it('closes the walk where asked, with the way home in moves', () => {
    const answer = ask([['1/3']] as RoomId[][], { end: '1/0' as RoomId });
    expect(answer?.home).toBe(3);
  });

  it('buys things got in the same rooms in one stop', () => {
    const answer = ask([['1/4'], ['1/2'], ['1/4']] as RoomId[][]);
    expect(answer?.stops.map((stop) => [stop.thing, stop.room, stop.moves])).toEqual([
      [1, '1/2', 2],
      [0, '1/4', 2],
      [2, '1/4', 0]
    ]);
  });

  it('orders more stops than the table takes, nearest first and then shortened', () => {
    // From 1/5 nearest first walks 1/4, 1/7, 1/9 and back to 1/0 (15 moves); out to 1/9 first is 13.
    const things = [['1/4'], ['1/7'], ['1/0'], ['1/9']] as RoomId[][];
    const from = '1/5' as RoomId;
    const order = (exact: number) =>
      tour(corridor, from, { things, places: 3, exact, end: null, by: 'moves' }, {});
    const moves = (exact: number) => order(exact)?.stops.reduce((sum, stop) => sum + stop.moves, 0);
    expect(moves(10)).toBe(13);
    expect(moves(0)).toBe(13);
  });

  it('keeps what every other thing waits on first past the table too', () => {
    const answer = ask([['1/2'], ['1/9'], ['1/3']] as RoomId[][], {
      first: new Set([1]),
      exact: 0
    });
    expect(answer?.stops.map((stop) => stop.thing)).toEqual([1, 2, 0]);
  });

  it('orders a walk whose nearest stop is a one-way pocket past the table too', () => {
    // 2/1 is one move off and has no way out; 2/2 is five off, and six on to 2/1.
    const pocket: TourWorld = {
      sweepTo(from, rooms) {
        const legs: Record<string, Record<string, number>> = {
          '2/0': { '2/1': 1, '2/2': 5 },
          '2/1': { '2/1': 0 },
          '2/2': { '2/1': 6, '2/2': 0 }
        };
        const found = new Map<RoomId, { cost: number; moves: number }>();
        for (const room of rooms) {
          const moves = legs[from]?.[room];
          if (moves !== undefined) found.set(room, { cost: moves, moves });
        }
        return found;
      }
    };
    const things = [['2/1'], ['2/2']] as RoomId[][];
    const order = (exact: number) =>
      tour(pocket, '2/0' as RoomId, { things, places: 3, exact, end: null, by: 'moves' }, {});
    expect(order(10)?.stops.map((stop) => stop.room)).toEqual(['2/2', '2/1']);
    expect(order(0)?.stops.map((stop) => stop.room)).toEqual(['2/2', '2/1']);
  });
});
