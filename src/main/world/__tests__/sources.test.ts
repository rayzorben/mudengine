import { describe, expect, it } from 'vitest';

import type { WorldMob, WorldRoom } from '../../../shared/world';
import { ItemSources, spokenFor, type SourceRealm } from '../navigation/sources';

const room = (map: number, number: number, extra: Partial<WorldRoom> = {}): WorldRoom =>
  ({ map, room: number, name: `Room ${number}`, exits: [], ...extra }) as WorldRoom;
const mob = (name: string, ids: number[]): WorldMob => ({ name, ids }) as unknown as WorldMob;

const ROOMS = [
  room(1, 1),
  room(1, 2),
  room(1, 3),
  room(1, 4, { commands: [{ say: ['ring bell'], summons: [30] }] }),
  room(1, 5),
  room(1, 6)
];
const ogre = mob('ogre', [30]);
const shaman = mob('shaman', [31]);
const realm: SourceRealm = {
  everyRoom: () => ROOMS,
  hasRoom: (id) => ROOMS.some((known) => `${known.map}/${known.room}` === id),
  sellingRooms: (item) => (item === 7 ? [ROOMS[0]!] : []),
  handovers: (item) =>
    item === 7
      ? [
          { kind: 'asked', who: 'smith', room: '1/2', say: ['key'] },
          { kind: 'said', room: '1/3', say: ['pull ring'] },
          { kind: 'killed', who: 'lich', room: '1/6' }
        ]
      : [],
  droppers: (item) => (item === 7 ? [ogre] : []),
  summonersOf: (who) => (who === ogre ? [shaman] : []),
  spawnRoomsOf: (who) => (who === ogre ? [{ room: ROOMS[4]! }] : [{ room: ROOMS[1]! }])
};

describe('every way the realm gives an item', () => {
  it('lists a counter, the words, the drops, the summons and a death', () => {
    const sources = new ItemSources(realm).of(7);
    expect(sources).toEqual([
      { kind: 'buy', room: '1/1' },
      { kind: 'ask', room: '1/2', say: 'ask smith key' },
      { kind: 'ask', room: '1/3', say: 'pull ring' },
      { kind: 'kill', monster: 'lich', room: '1/6', certain: true },
      { kind: 'kill', monster: 'ogre', room: '1/5' },
      { kind: 'kill', monster: 'ogre', room: '1/2', summon: { by: 'shaman' } },
      { kind: 'kill', monster: 'ogre', room: '1/4', summon: { say: 'ring bell' } }
    ]);
    expect(sources.map(spokenFor)).toEqual([
      null,
      'ask smith key',
      'pull ring',
      null,
      null,
      null,
      'ring bell'
    ]);
  });

  /* A death that hands a key over is a place to get it. */
  it('counts the room of a death that hands the item over', () => {
    expect(new ItemSources(realm).of(7).map((source) => source.room)).toContain('1/6');
  });
});
