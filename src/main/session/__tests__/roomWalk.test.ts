import { describe, expect, it } from 'vitest';

import { roomNamed } from '../roomWalk';
import type { RoomMatch } from '../../../shared/loops';
import type { RoomReference } from '../../../shared/world';

/* `@goto` and `{goto}` read a MegaMUD code before a room name (todo 144). */
describe('the room a request names', () => {
  const asked: string[] = [];
  const rooms = {
    roomCoded: (code: string): RoomReference | null =>
      code.toUpperCase() === 'VXDF' ? { map: 3, room: 784 } : null,
    matchStop: (stop: { name: string; at: RoomReference | null }): RoomMatch => {
      asked.push(stop.name);
      return stop.name === 'VXDF' ? { kind: 'one', at: { map: 5, room: 1 } } : { kind: 'none' };
    }
  };

  it('answers a MegaMUD code with its room, case ignored', () => {
    expect(roomNamed('vxdf', rooms)).toEqual({ kind: 'one', at: { map: 3, room: 784 } });
  });

  it('keeps a room of that name beside the code, rather than walking either', () => {
    expect(roomNamed('VXDF', rooms)).toEqual({
      kind: 'several',
      rooms: [
        { map: 3, room: 784 },
        { map: 5, room: 1 }
      ]
    });
  });

  it('reads anything else as a room name or address', () => {
    expect(roomNamed('Darkwood Forest', rooms)).toEqual({ kind: 'none' });
    expect(asked.at(-1)).toBe('Darkwood Forest');
  });
});
