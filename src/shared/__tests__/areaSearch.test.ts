import { describe, expect, it } from 'vitest';

import { orderTour } from '../areaSearch';
import type { RoomId } from '../world';

/** Moves between rooms over undirected corridors, by breadth-first search: a test's map. */
function mapOf(
  edges: Array<[string, string]>,
  oneWay: Array<[string, string]> = []
): (room: RoomId, most: number) => ReadonlyMap<RoomId, number> {
  const next = new Map<string, string[]>();
  for (const [a, b] of [...edges, ...oneWay]) next.set(a, [...(next.get(a) ?? []), b]);
  for (const [a, b] of edges) next.set(b, [...(next.get(b) ?? []), a]);
  return (from, most) => {
    const moves = new Map<RoomId, number>([[from, 0]]);
    let frontier = [from];
    for (let away = 0; away < most && frontier.length > 0; away += 1) {
      const after: string[] = [];
      for (const room of frontier) {
        for (const beside of next.get(room) ?? []) {
          if (moves.has(beside)) continue;
          moves.set(beside, (moves.get(room) ?? 0) + 1);
          after.push(beside);
        }
      }
      frontier = after;
    }
    return moves;
  };
}

describe('the order an area is searched in', () => {
  it('starts where the character stands and walks a corridor once', () => {
    const moves = mapOf([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd']
    ]);
    expect(orderTour('a', new Set(['a', 'b', 'c', 'd']), moves, 10)).toEqual({
      tour: ['a', 'b', 'c', 'd'],
      steps: 3,
      stranded: []
    });
  });

  it('clears a side room before going on, rather than coming back for it', () => {
    // a - b - c - e, with a dead end d off b: b's nearest are c and d, and d has nothing beyond.
    const moves = mapOf([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'e'],
      ['b', 'd']
    ]);
    const { tour, steps } = orderTour('a', new Set(['a', 'b', 'c', 'd', 'e']), moves, 10);
    expect(tour).toEqual(['a', 'b', 'd', 'c', 'e']);
    expect(steps).toBe(5);
  });

  it('keeps a one-way drop for the end, so the rooms behind are searched first', () => {
    // a drops one way into c, which leads nowhere back; b and d are the rest.
    const moves = mapOf(
      [
        ['a', 'b'],
        ['b', 'd']
      ],
      [['a', 'c']]
    );
    expect(orderTour('a', new Set(['a', 'b', 'c', 'd']), moves, 10)).toEqual({
      tour: ['a', 'b', 'd', 'c'],
      // Back through b and a to the drop.
      steps: 5,
      stranded: []
    });
  });

  it('leaves out a room no room in the order reaches', () => {
    const moves = mapOf([['a', 'b']]);
    expect(orderTour('a', new Set(['a', 'b', 'z']), moves, 10).stranded).toEqual(['z']);
  });

  it('starts from the character even where its own room is not searched', () => {
    const moves = mapOf([
      ['a', 'b'],
      ['b', 'c']
    ]);
    expect(orderTour('a', new Set(['c', 'b']), moves, 10).tour).toEqual(['b', 'c']);
  });
});
