import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

import { NicknameShelf, RoomNicknames, type NicknameRooms } from '../RoomNicknames';
import { findRooms, type RoomSearchParts } from '../roomSearch';
import {
  asRoomNicknames,
  roomNameFaults,
  statedRoomNames,
  writtenRoomNames,
  type RoomNameRefusal,
  type RoomNickname,
  type StatedRoomName
} from '../../../shared/roomNicknames';
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
      { shipped: () => [VORTEX], own: () => [] },
      {
        fitted: (kept, shipped) => said.push(`${kept}/${shipped}`),
        unfit: (codes) => said.push(`unfit ${codes.join()}`),
        overrides: (codes) => said.push(`over ${codes.join()}`)
      }
    );
    const world = realm(ROOMS);
    expect(shelf.of(world)).toBe(shelf.of(world));
    shelf.of(realm([]));
    expect(said).toEqual(['1/1', '0/1']);
  });
});

describe("the player's own room names", () => {
  const mine = nickname({
    code: 'vxdf',
    name: 'My vortex',
    room: { name: 'Goblin Caves', at: { map: 4, room: 10 } }
  });
  const elsewhere = nickname({
    code: 'FARM',
    name: 'The far farm',
    room: { name: 'Farm', at: { map: 9, room: 9 } }
  });

  it('go in front of the shipped ones, and a code of theirs takes the shipped place', () => {
    const names = new RoomNicknames([VORTEX, FORK], realm(ROOMS), [mine]);
    expect(names.byCode('VXDF')?.nickname.name).toBe('My vortex');
    expect(names.search('vortex', 25).map((each) => each.nickname.name)).toEqual(['My vortex']);
    expect(names.nameOf('3/784')).toBeNull();
    expect(names.nameOf('4/10')?.name).toBe('My vortex');
    expect(names.overrides).toEqual(['VXDF']);
    expect(names.shippedKept).toBe(1);
  });

  it('leave out one whose room the realm does not have, which leaves the shipped code', () => {
    const away = nickname({ ...elsewhere, code: 'VXDF' });
    const names = new RoomNicknames([VORTEX], realm(ROOMS), [away]);
    expect(names.unfit).toEqual(['VXDF']);
    expect(names.overrides).toEqual([]);
    // Positive control: the shipped entry of that code answers.
    expect(names.byCode('vxdf')?.nickname.name).toBe('Darkwood Forest Vortex');
  });

  it('are said once per change of the list, and rebuilt when it changes', () => {
    const said: string[] = [];
    let own: RoomNickname[] = [mine, elsewhere];
    const shelf = new NicknameShelf(
      { shipped: () => [VORTEX], own: () => own },
      {
        fitted: (kept, shipped) => said.push(`${kept}/${shipped}`),
        unfit: (codes) => said.push(`unfit ${codes.join()}`),
        overrides: (codes) => said.push(`over ${codes.join()}`)
      }
    );
    const world = realm(ROOMS);
    const first = shelf.of(world);
    own = [{ ...mine }, { ...elsewhere }];
    expect(shelf.of(world)).toBe(first);
    expect(said).toEqual(['0/1', 'unfit FARM', 'over VXDF']);
    own = [];
    expect(shelf.of(world).byCode('vxdf')?.nickname.name).toBe('Darkwood Forest Vortex');
    expect(said).toEqual(['0/1', 'unfit FARM', 'over VXDF']);
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
    const repeated: RoomNameRefusal[] = [];
    const read = asRoomNicknames(
      [
        entry('VXDF', 'Darkwood Forest 3/784'),
        entry('vxdf', 'Cave 7/1'),
        entry('VXHS', 'Hazy Swamp 3/782')
      ],
      (refusal) => repeated.push(refusal)
    );
    expect(read.map((each) => each.room.at)).toEqual([
      { map: 3, room: 784 },
      { map: 3, room: 782 }
    ]);
    expect(repeated).toEqual([{ at: 1, code: 'vxdf', fault: 'repeated' }]);
  });

  it('leaves out an entry with no address, a name or a code, and says which', () => {
    const refused: RoomNameRefusal[] = [];
    expect(
      asRoomNicknames(
        [
          entry('VXDF', 'Darkwood Forest'),
          { code: 'VXHS', room: 'Hazy Swamp 3/782' },
          entry('two words', 'Hazy Swamp 3/782')
        ],
        (refusal) => refused.push(refusal)
      )
    ).toEqual([]);
    expect(refused.map((each) => each.fault)).toEqual(['room', 'name', 'code']);
  });
});

describe('the room names as the settings page edits them', () => {
  const row = (over: Partial<StatedRoomName>): StatedRoomName => ({
    code: '',
    name: '',
    room: '',
    stopBefore: false,
    avoid: false,
    hidden: false,
    minLevel: null,
    maxLevel: null,
    ...over
  });

  it('reads back what it writes, and writes no blank row', () => {
    const rows = [
      row({ code: 'GATE', name: 'Gates', room: 'Town Gates 1/1', stopBefore: true, minLevel: 3 }),
      row({})
    ];
    const written = writtenRoomNames(rows);
    expect(written).toEqual([
      { code: 'GATE', name: 'Gates', room: 'Town Gates 1/1', stopBefore: true, minLevel: 3 }
    ]);
    expect(statedRoomNames(written)).toEqual([rows[0]]);
    expect(asRoomNicknames(written).map((each) => each.code)).toEqual(['GATE']);
  });

  it('finds each refused row by its place, past a blank row', () => {
    const faults = roomNameFaults([
      row({ code: 'GATE', name: 'Gates', room: 'Town Gates 1/1' }),
      row({}),
      row({ code: 'gate', name: 'Again', room: 'Town Gates 1/1' }),
      row({ code: 'HALF', name: 'Half typed' })
    ]);
    expect([...faults]).toEqual([
      [2, 'repeated'],
      [3, 'room']
    ]);
  });
});
