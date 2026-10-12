import { describe, expect, it } from 'vitest';

import { Push } from '@shared/ipc';

import { PushPatches } from '../patches';

const patch = (s: string, set: Record<string, unknown>, drop: string[] = []) =>
  ({ k: 'patch', c: Push.character, s, set, drop }) as const;

describe('putting a patched push back together', () => {
  it('builds the whole payload, keeping what did not change as the same object', () => {
    const patches = new PushPatches();
    const room = { name: 'Town Square' };
    const first = patches.apply(patch('festus', { room, hp: 10 }));
    expect(first).toEqual({
      k: 'push',
      c: Push.character,
      p: { session: 'festus', payload: { room, hp: 10 } }
    });
    const next = patches.apply(patch('festus', { hp: 9 }));
    const payload = (next.p as { payload: { room: unknown; hp: number } }).payload;
    expect(payload.hp).toBe(9);
    // Nothing reading the room redraws.
    expect(payload.room).toBe(room);
  });

  it('drops a field the patch names, and keeps characters apart', () => {
    const patches = new PushPatches();
    patches.apply(patch('festus', { hp: 1, party: ['a'] }));
    patches.apply(patch('rayzor', { hp: 5 }));
    expect(patches.apply(patch('festus', {}, ['party'])).p).toEqual({
      session: 'festus',
      payload: { hp: 1 }
    });
  });

  it('starts again from nothing once cleared', () => {
    const patches = new PushPatches();
    patches.apply(patch('festus', { hp: 1, mana: 2 }));
    patches.clear();
    expect(patches.apply(patch('festus', { hp: 3 })).p).toEqual({
      session: 'festus',
      payload: { hp: 3 }
    });
  });
});
