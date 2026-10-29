import { describe, expect, it } from 'vitest';

import { PushPatcher } from '../web/patches';
import { asRpcFrame, type RpcPatch, type RpcPush } from '../../../shared/rpc';
import { Push } from '../../../shared/ipc';

const character = (session: string, payload: Record<string, unknown>): RpcPush => ({
  k: 'push',
  c: Push.character,
  p: { session, payload }
});

/** What the tab reads off the wire, as its bridge parses it. */
function onTheWire(body: string | null): RpcPatch {
  if (body === null) throw new Error('not patched');
  const frame = asRpcFrame(JSON.parse(`{"n":1,${body}`));
  if (frame === null || frame.k !== 'patch') throw new Error(`not a patch: ${body}`);
  return frame;
}

describe('a character push sent as what changed', () => {
  it('sends everything first, then only the fields that changed', () => {
    const patcher = new PushPatcher();
    const room = { name: 'Town Square', exits: ['n', 's'] };
    expect(onTheWire(patcher.patch(character('festus', { room, hp: 10 }))).set).toEqual({
      room,
      hp: 10
    });
    const second = onTheWire(patcher.patch(character('festus', { room, hp: 9 })));
    expect(second).toEqual({
      k: 'patch',
      n: 1,
      c: Push.character,
      s: 'festus',
      set: { hp: 9 },
      deep: {},
      drop: []
    });
  });

  it('names a field the state no longer has', () => {
    const patcher = new PushPatcher();
    patcher.patch(character('festus', { hp: 1, party: ['a'] }));
    expect(onTheWire(patcher.patch(character('festus', { hp: 1 }))).drop).toEqual(['party']);
  });

  it('keeps each character apart', () => {
    const patcher = new PushPatcher();
    patcher.patch(character('festus', { hp: 1 }));
    expect(onTheWire(patcher.patch(character('rayzor', { hp: 1 }))).set).toEqual({ hp: 1 });
  });

  it('sends every other push whole', () => {
    expect(new PushPatcher().patch({ k: 'push', c: Push.notice, p: { message: 'x' } })).toBeNull();
  });

  /*
   * The tally's experience samples were 24 KB of every character patch,
   * re-sent whole on each blow (2026-10-29 UTC).
   */
  it('sends a changed record as what changed in it, and a list as its new tail', () => {
    const patcher = new PushPatcher();
    const samples = Array.from({ length: 600 }, (_, at) => ({ at, experience: at * 10 }));
    const dealt = { melee: { count: 4, damage: 40 } };
    patcher.patch(character('festus', { tally: { samples, dealt, missed: 1 }, hp: 9 }));
    const kill = [...samples.slice(0, -1), { at: 599, experience: 9_999 }];
    const body = patcher.patch(
      character('festus', { tally: { samples: kill, dealt, missed: 2 }, hp: 9 })
    );
    expect(onTheWire(body)).toMatchObject({
      set: {},
      deep: {
        tally: {
          k: 'fields',
          set: { missed: 2 },
          deep: {
            samples: { k: 'tail', skip: 0, keep: 599, tail: [{ at: 599, experience: 9_999 }] }
          },
          drop: []
        }
      },
      drop: []
    });
    expect(body!.length).toBeLessThan(300);
  });

  it('sends a list trimmed at its head as its new end, and a changed one whole', () => {
    const patcher = new PushPatcher();
    patcher.patch(character('festus', { samples: [1, 2, 3], buffs: ['bless', 'shield'] }));
    const next = onTheWire(
      patcher.patch(character('festus', { samples: [2, 3, 4], buffs: ['cure', 'light'] }))
    );
    expect(next.deep).toEqual({ samples: { k: 'tail', skip: 1, keep: 2, tail: [4] } });
    expect(next.set).toEqual({ buffs: ['cure', 'light'] });
  });
});
