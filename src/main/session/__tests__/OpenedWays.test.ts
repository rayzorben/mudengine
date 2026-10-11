import { describe, expect, it } from 'vitest';

import { OpenedWays } from '../OpenedWays';

const HOLD = 300_000;
import type { CharacterState } from '../../../shared/character';
import type { WorldRoom } from '../../../shared/world';

/** 1/1 east to 1/2 through a door, and 1/2 west back; 1/3 has nothing back. */
const ROOMS: Record<string, WorldRoom> = {
  '1/1': {
    map: 1,
    room: 1,
    name: 'Hall',
    exits: [
      { direction: 'e', map: 1, room: 2, requirement: { kind: 'door', raw: 'Door' } },
      {
        direction: 's',
        map: 1,
        room: 3,
        requirement: { kind: 'hidden', raw: 'Hidden/Searchable', searchable: true }
      }
    ]
  } as WorldRoom,
  '1/2': {
    map: 1,
    room: 2,
    name: 'Cell',
    exits: [{ direction: 'w', map: 1, room: 1, requirement: { kind: 'door', raw: 'Door' } }]
  } as WorldRoom
};

const world = { byId: (id: string) => ROOMS[id] };

const standing = (exits: Array<[string, string | null]>): CharacterState =>
  ({
    room: { map: 1, number: 1, exits: exits.map(([direction, note]) => ({ direction, note })) }
  }) as unknown as CharacterState;

describe('the ways the walk opened, on the server clock', () => {
  it('holds a door both ways until the shortest timer runs out', () => {
    const ways = new OpenedWays(() => world);
    ways.noteOpened('1/1', 'e', 'door', 0);
    expect([...ways.openAt(HOLD - 1, HOLD)].sort()).toEqual(['1/1|e', '1/2|w']);
    expect(ways.openAt(HOLD, HOLD).size).toBe(0);
  });

  it('holds a hidden exit on its own side only', () => {
    const ways = new OpenedWays(() => world);
    ways.noteOpened('1/1', 's', 'hidden', 0);
    expect([...ways.openAt(1, HOLD)]).toEqual(['1/1|s']);
  });

  it('forgets a door the room calls closed, and a found exit the room no longer lists', () => {
    const ways = new OpenedWays(() => world);
    ways.noteOpened('1/1', 'e', 'door', 0);
    ways.noteOpened('1/1', 's', 'hidden', 0);
    // Positive control: a room listing both as open keeps both.
    ways.onRoom(
      standing([
        ['e', 'open door'],
        ['s', null]
      ])
    );
    expect(ways.openAt(1, HOLD).has('1/1|e')).toBe(true);
    expect(ways.openAt(1, HOLD).has('1/1|s')).toBe(true);
    ways.onRoom(standing([['e', 'closed door']]));
    expect(ways.openAt(1, HOLD).has('1/1|e')).toBe(false);
    expect(ways.openAt(1, HOLD).has('1/1|s')).toBe(false);
    // The far side is not this room's to say.
    expect(ways.openAt(1, HOLD).has('1/2|w')).toBe(true);
  });

  it('reads nothing off a room whose exits were not printed', () => {
    const ways = new OpenedWays(() => world);
    ways.noteOpened('1/1', 's', 'hidden', 0);
    ways.onRoom(standing([]));
    expect(ways.openAt(1, HOLD).has('1/1|s')).toBe(true);
  });
});
