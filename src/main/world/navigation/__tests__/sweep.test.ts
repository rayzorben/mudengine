import { describe, expect, it } from 'vitest';

import { roomId, type RoomId, type WorldExit, type WorldRoom } from '../../../../shared/world';
import type { PortalExit } from '../../RoomIndex';
import { sweep, type SweepRooms } from '../sweep';

/*
 * A row of rooms 1/1 → 1/2 → 1/3 → 1/4, an exit from 1/1 into a room the data
 * lacks (1/9), a teleporting exit 1/1 → 1/2 that lands in 1/4, and a portal
 * out of 1/2 into 2/1.
 */
const exit = (to: number): WorldExit => ({ direction: 'e', map: 1, room: to, requirement: null });
const room = (n: number, exits: WorldExit[]): WorldRoom => ({ map: 1, room: n, name: '', exits });
const teleport = exit(2);
const rooms = new Map<RoomId, WorldRoom>([
  ['1/1', room(1, [exit(2), exit(9), teleport])],
  ['1/2', room(2, [exit(3)])],
  ['1/3', room(3, [exit(4)])],
  ['1/4', room(4, [])],
  ['2/1', { map: 2, room: 1, name: '', exits: [] }]
]);
const portal: PortalExit = {
  direction: 'portal',
  map: 2,
  room: 1,
  requirement: { kind: 'text', raw: 'go hole' }
};
const realm: SweepRooms = {
  roomsById: rooms,
  portalsFrom: (id) => (id === '1/2' ? [portal] : []),
  beyond: (way) => (way === teleport ? '1/4' : roomId(way.map, way.room))
};

describe('the engine sweep', () => {
  it('reaches every room with its fewest moves, never a room the data lacks', () => {
    const got = sweep(realm, '1/1', { lands: 'table', portals: false });
    expect([...got]).toEqual([
      ['1/1', 0],
      ['1/2', 1],
      ['1/3', 2],
      ['1/4', 3]
    ]);
  });

  it('lands where the character lands, and walks a portal only when asked', () => {
    expect(sweep(realm, '1/1', { lands: 'beyond', portals: false }).get('1/4')).toBe(1);
    expect(sweep(realm, '1/1', { lands: 'table', portals: true }).get('2/1')).toBe(2);
    expect(sweep(realm, '1/1', { lands: 'table', portals: false }).has('2/1')).toBe(false);
  });

  it('stops at a ring, at a way it may not walk, and where a visit says so', () => {
    expect([...sweep(realm, '1/1', { lands: 'table', portals: false, steps: 1 }).keys()]).toEqual([
      '1/1',
      '1/2'
    ]);
    const walled = sweep(realm, '1/1', {
      lands: 'table',
      portals: false,
      walks: (way) => way.room !== 3
    });
    expect(walled.has('1/3')).toBe(false);
    const seen: RoomId[] = [];
    sweep(realm, '1/1', {
      lands: 'table',
      portals: false,
      visit: (id) => {
        seen.push(id);
        return id !== '1/2';
      }
    });
    expect(seen).toEqual(['1/1', '1/2']);
  });

  it('answers nothing from a room the data lacks', () => {
    expect(sweep(realm, '7/7', { lands: 'table', portals: true }).size).toBe(0);
  });
});
