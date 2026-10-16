import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

import { NicknameShelf, RoomNicknames, type NicknameRooms } from '../RoomNicknames';
import { findRooms, type RoomSearchParts } from '../roomSearch';
import { asRoomNicknames, type RoomNickname } from '../../../shared/roomNicknames';
import type { WorldRoom } from '../../../shared/world';

const room = (map: number, number: number, name: string): WorldRoom =>
  ({ map, room: number, name, exits: [] }) as unknown as WorldRoom;

const nickname = (
  over: Partial<RoomNickname> & Pick<RoomNickname, 'code' | 'name'>
): RoomNickname => ({
  room: { name: 'Darkwood Forest', at: { map: 3, room: 784 } },
  stopBefore: false,
  avoid: false,
  hidden: false,
  minLevel: null,
  maxLevel: null,
  ...over
});

const VORTEX = nickname({ code: 'VXDF', name: 'Darkwood Forest Vortex' });
const FORK = nickname({
  code: 'GCSF',
  name: 'Goblin Caves (Slavemaster fork)',
  room: { name: 'Goblin Caves', at: { map: 4, room: 10 } },
  hidden: true
});
const ROOMS = [
  room(3, 784, 'Darkwood Forest'),
  room(3, 785, 'Darkwood Forest'),
  room(4, 10, 'Goblin Caves')
];

const realm = (rooms: readonly WorldRoom[]): NicknameRooms & RoomSearchParts['world'] => ({
  get: (map, number) => rooms.find((each) => each.map === map && each.room === number),
  searchByName: (query) =>
    rooms.filter((each) => each.name.toLowerCase().includes(query.toLowerCase()))
});

describe('MegaMUD room names on a realm', () => {
  const names = new RoomNicknames([VORTEX, FORK], realm(ROOMS));

  it('finds a room by its code, case ignored', () => {
    expect(names.byCode('vxdf')?.room.room).toBe(784);
    expect(names.byCode('VXDF')?.nickname.name).toBe('Darkwood Forest Vortex');
  });

  it('finds a room by part of its MegaMUD name', () => {
    expect(names.search('forest vortex', 25).map((each) => each.nickname.code)).toEqual(['VXDF']);
  });

  it('finds a hidden name by its code and never by its name', () => {
    expect(names.byCode('gcsf')?.room.room).toBe(10);
    expect(names.search('slavemaster', 25)).toEqual([]);
  });

  it('keeps an entry only where the realm has its room under the same name', () => {
    // The positive control above keeps both; here 3/784 is called something else.
    const renamed = new RoomNicknames([VORTEX, FORK], realm([room(3, 784, 'Cave'), ROOMS[2]!]));
    expect(renamed.byCode('vxdf')).toBeNull();
    expect(renamed.size).toBe(1);
  });

  it('names a room by the entry that stops before it, whichever is listed first', () => {
    const plain = nickname({ code: 'VXHS', name: 'Hazy Swamp Vortex' });
    const boss = nickname({ code: 'HSBS', name: 'Swamp Boss', stopBefore: true });
    const both = new RoomNicknames([plain, boss], realm(ROOMS));
    expect(both.nameOf('3/784')?.code).toBe('HSBS');
    // Positive control: with no boss entry the first listed is the name.
    expect(new RoomNicknames([plain], realm(ROOMS)).nameOf('3/784')?.code).toBe('VXHS');
  });

  it('is built once per world, and says how many fit', () => {
    const said: string[] = [];
    const shelf = new NicknameShelf(
      () => [VORTEX],
      (kept, shipped) => said.push(`${kept}/${shipped}`)
    );
    const world = realm(ROOMS);
    expect(shelf.of(world)).toBe(shelf.of(world));
    shelf.of(realm([]));
    expect(said).toEqual(['1/1', '0/1']);
  });
});

describe('a room search', () => {
  const world = realm(ROOMS);
  const parts = (visited: string[] = []): RoomSearchParts => ({
    world,
    nicknames: new RoomNicknames([VORTEX, FORK], world),
    recent: (query, limit) =>
      visited
        .map((id) => ({ id, name: 'Darkwood Forest', at: 1, visits: 1 }))
        .filter(
          (entry) => query.trim() === '' || entry.name.toLowerCase().includes(query.toLowerCase())
        )
        .slice(0, limit),
    recentShown: 5,
    nicknameRows: 25
  });
  const ids = (query: string, visited?: string[]): string[] =>
    findRooms(query, parts(visited)).map((each) => `${each.map}/${each.room}`);

  it('answers a code and a MegaMUD name with that room first', () => {
    expect(ids('vxdf')[0]).toBe('3/784');
    expect(ids('darkwood forest vortex')).toEqual(['3/784']);
    expect(findRooms('vxdf', parts())[0]?.nickname?.code).toBe('VXDF');
  });

  it('still lists the realm rows after the MegaMUD ones, each room once', () => {
    expect(ids('darkwood')).toEqual(['3/784', '3/785']);
    expect(ids('darkwood', ['3/785'])).toEqual(['3/785', '3/784']);
  });

  it('carries the MegaMUD name on a row found otherwise', () => {
    const [byAddress] = findRooms('3/784', parts());
    expect(byAddress?.nickname?.code).toBe('VXDF');
    expect(findRooms('3/785', parts())[0]?.nickname).toBeNull();
  });
});

describe('the shipped room names', () => {
  const file = path.resolve('resources/rooms/megamud.yaml');
  const shipped = asRoomNicknames(
    (parse(fs.readFileSync(file, 'utf8')) as { rooms: unknown }).rooms
  );

  it('is a substantial list that names the Darkwood Forest vortex', () => {
    // 1,583 of ROOMS.md's 1,674 at the time of writing; a floor, not a figure.
    expect(shipped.length).toBeGreaterThan(1_500);
    const vortex = shipped.find((each) => each.code === 'VXDF');
    expect(vortex?.room).toEqual({ name: 'Darkwood Forest', at: { map: 3, room: 784 } });
  });

  it('marks the boss rooms MegaMUD stops before entering', () => {
    expect(shipped.filter((each) => each.stopBefore).length).toBeGreaterThan(150);
  });
});

describe('reading the room names', () => {
  const entry = (code: string, room: string) => ({ code, name: 'Vortex', room });

  it('keeps the first of a code listed twice and says so', () => {
    const repeated: string[] = [];
    const read = asRoomNicknames(
      [
        entry('VXDF', 'Darkwood Forest 3/784'),
        entry('vxdf', 'Cave 7/1'),
        entry('VXHS', 'Hazy Swamp 3/782')
      ],
      (code) => repeated.push(code)
    );
    expect(read.map((each) => each.room.at)).toEqual([
      { map: 3, room: 784 },
      { map: 3, room: 782 }
    ]);
    expect(repeated).toEqual(['vxdf']);
  });

  it('leaves out an entry with no address, and says nothing of it', () => {
    const repeated: string[] = [];
    expect(
      asRoomNicknames([entry('VXDF', 'Darkwood Forest')], (code) => repeated.push(code))
    ).toEqual([]);
    expect(repeated).toEqual([]);
  });
});
