import { describe, expect, it } from 'vitest';

import { fromWire } from '../wire';
import { PUSH_METHODS, type PushText, type WireApi } from '@shared/ipc';

/* The desktop bridge: each push arrives as text and is handed on parsed; the rest passes through. */
describe('the desktop bridge', () => {
  it('parses every push and passes every other method through', () => {
    const heard: Record<string, (text: PushText) => void> = {};
    const unsubscribed: string[] = [];
    const fake = Object.fromEntries(
      PUSH_METHODS.map((method) => [
        method,
        (handler: (text: PushText) => void) => {
          heard[method] = handler;
          return () => unsubscribed.push(method);
        }
      ])
    );
    const getState = (): Promise<string> => Promise.resolve('state');
    const api = fromWire({ ...fake, host: 'electron', getState } as unknown as WireApi);

    const got: unknown[] = [];
    const stop = api.onCharacter((message) => got.push(message));
    heard['onCharacter']?.(JSON.stringify({ session: 's1', payload: { hp: 5 } }));
    expect(got).toEqual([{ session: 's1', payload: { hp: 5 } }]);
    stop();
    expect(unsubscribed).toEqual(['onCharacter']);

    const notices: unknown[] = [];
    api.onStatsBase((message) => notices.push(message));
    heard['onStatsBase']?.('null');
    expect(notices).toEqual([null]);

    expect(api.host).toBe('electron');
    expect(api.getState).toBe(getState);
  });
});
