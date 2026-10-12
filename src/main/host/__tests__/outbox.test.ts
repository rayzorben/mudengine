import { describe, expect, it } from 'vitest';

import { TabOutbox } from '../web/outbox';
import { Push } from '../../../shared/ipc';
import type { RpcOutbound } from '../../../shared/rpc';

/* Todo 836: what goes to a browser tab, and when. */
describe('a tab outbox', () => {
  const push = (c: string, p: unknown): RpcOutbound => ({ k: 'push', c, p }) as RpcOutbound;
  const admit = (outbox: TabOutbox, message: RpcOutbound): boolean =>
    outbox.admits(message, JSON.stringify(message));

  it('answers a request at once, and holds pushes until the tab is ready', () => {
    const outbox = new TabOutbox();
    expect(admit(outbox, { k: 'reply', id: 1, r: 'scrollback' } as RpcOutbound)).toBe(true);
    expect(admit(outbox, push(Push.character, { session: 's1', payload: { hp: 1 } }))).toBe(false);
    outbox.markReady();
    expect(admit(outbox, push(Push.character, { session: 's1', payload: { hp: 1 } }))).toBe(true);
  });

  it('skips a character push identical to the last one for that session', () => {
    const outbox = new TabOutbox();
    outbox.markReady();
    const same = push(Push.character, { session: 's1', payload: { hp: 5 } });
    expect(admit(outbox, same)).toBe(true);
    expect(admit(outbox, same)).toBe(false);
    // Another session's, and the same session's changed, still go.
    expect(admit(outbox, push(Push.character, { session: 's2', payload: { hp: 5 } }))).toBe(true);
    expect(admit(outbox, push(Push.character, { session: 's1', payload: { hp: 6 } }))).toBe(true);
    // Any other push is sent every time.
    const other = push(Push.characterReset, { session: 's1', payload: 'x' });
    expect(admit(outbox, other)).toBe(true);
    expect(admit(outbox, other)).toBe(true);
  });
});
