import { describe, expect, it } from 'vitest';

import { retrace } from '../retrace';
import type { Direction, WorldRoom } from '../../../../shared/world';

const exit = (direction: Direction, room: number) => ({
  direction,
  map: 1,
  room,
  requirement: null
});
const ROOMS = [
  { map: 1, room: 1, name: 'Tunnel', exits: [exit('e', 2)] },
  { map: 1, room: 2, name: 'Tunnel', exits: [exit('e', 3), exit('w', 1)] },
  { map: 1, room: 3, name: 'Junction', exits: [exit('w', 2)] },
  { map: 1, room: 4, name: 'Cave', exits: [exit('n', 6)] },
  { map: 1, room: 5, name: 'Cave', exits: [exit('n', 6)] },
  { map: 1, room: 6, name: 'Mouth', exits: [] }
] as unknown as WorldRoom[];
const world = { findByName: (name: string) => ROOMS.filter((r) => r.name === name) };
const at = (room: number): WorldRoom => ROOMS.find((r) => r.room === room)!;

describe('retrace', () => {
  it('follows the exits stepped through backwards, checking each name', () => {
    const rooms = retrace(world, at(3), [
      { name: 'Tunnel', onward: 'e' },
      { name: 'Tunnel', onward: 'stayed' },
      { name: 'Tunnel', onward: 'e' }
    ]);
    expect(rooms.map((r) => r.room)).toEqual([2, 2, 1]);
  });

  it('stops at a name that does not fit', () => {
    const rooms = retrace(world, at(3), [
      { name: 'Tunnel', onward: 'e' },
      { name: 'Junction', onward: 'e' }
    ]);
    expect(rooms.map((r) => r.room)).toEqual([2]);
  });

  it('stops where two rooms lead on the same way', () => {
    expect(retrace(world, at(6), [{ name: 'Cave', onward: 'n' }])).toEqual([]);
  });

  it('stops where the way on is unknown', () => {
    expect(retrace(world, at(3), [{ name: 'Tunnel', onward: null }])).toEqual([]);
  });
});
