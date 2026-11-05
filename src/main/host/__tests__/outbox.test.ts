import { describe, expect, it } from 'vitest';

import { TabOutbox } from '../web/outbox';
import { Push } from '../../../shared/ipc';
import type { RpcOutbound } from '../../../shared/rpc';

/* Todo 836: when a message goes to a browser tab. A repeat is the patcher's (`patches.test.ts`). */
describe('a tab outbox', () => {
  const push = (c: string, p: unknown): RpcOutbound => ({ k: 'push', c, p }) as RpcOutbound;

  it('answers a request at once, and holds pushes until the tab is ready', () => {
    const outbox = new TabOutbox();
    expect(outbox.admits({ k: 'reply', id: 1, r: 'scrollback' } as RpcOutbound)).toBe(true);
    expect(outbox.admits(push(Push.character, { session: 's1', payload: { hp: 1 } }))).toBe(false);
    outbox.markReady();
    expect(outbox.admits(push(Push.character, { session: 's1', payload: { hp: 1 } }))).toBe(true);
  });
});
