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
});
