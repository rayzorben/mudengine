import { describe, expect, it } from 'vitest';

import { Push } from '@shared/ipc';
import type { RpcPatch } from '@shared/rpc';

import { PushPatches } from '../patches';

const patch = (
  s: string,
  set: Record<string, unknown>,
  drop: string[] = [],
  deep: RpcPatch['deep'] = {}
): RpcPatch => ({ k: 'patch', c: Push.character, s, set, deep, drop });

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

  /*
   * The tally's experience samples were 24 KB of every character patch,
   * re-sent whole on each blow (2026-10-29 UTC): a kill now sends its one.
   */
  it('puts back a record and a list from what changed inside them', () => {
    const patches = new PushPatches();
    const dealt = { melee: 4 };
    const first = { at: 1, experience: 10 };
    patches.apply(
      patch('festus', { tally: { dealt, samples: [first, { at: 2, experience: 20 }] } })
    );
    const next = patches.apply(
      patch('festus', {}, [], {
        tally: {
          k: 'fields',
          set: {},
          deep: { samples: { k: 'tail', skip: 0, keep: 1, tail: [{ at: 2, experience: 25 }] } },
          drop: []
        }
      })
    );
    const tally = (next.p as { payload: { tally: { dealt: unknown; samples: unknown[] } } }).payload
      .tally;
    expect(tally).toEqual({ dealt, samples: [first, { at: 2, experience: 25 }] });
    expect(tally.dealt).toBe(dealt);
    expect(tally.samples[0]).toBe(first);
  });

  it('refuses a patch that does not fit what it holds', () => {
    const patches = new PushPatches();
    patches.apply(patch('festus', { tally: { samples: [] } }));
    expect(() =>
      patches.apply(
        patch('festus', {}, [], {
          tally: {
            k: 'fields',
            set: {},
            deep: { samples: { k: 'tail', skip: 0, keep: 3, tail: [] } },
            drop: []
          }
        })
      )
    ).toThrow(/keeps 3 items/);
  });

  it('keeps a list trimmed at its head as it grows', () => {
    const patches = new PushPatches();
    patches.apply(patch('festus', { samples: [1, 2, 3] }));
    const next = patches.apply(
      patch('festus', {}, [], { samples: { k: 'tail', skip: 1, keep: 2, tail: [4] } })
    );
    expect((next.p as { payload: { samples: number[] } }).payload.samples).toEqual([2, 3, 4]);
  });
});
