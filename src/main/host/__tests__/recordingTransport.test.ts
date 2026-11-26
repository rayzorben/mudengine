import { describe, expect, it } from 'vitest';

import { Invoke, Send } from '../../../shared/ipc';
import type { Caller, Handler, Transport } from '../Host';
import { describeCall, recordingTransport } from '../recordingTransport';

const caller: Caller = { windowId: 1, send: () => undefined };

/** A transport that keeps what was registered, so a test can call it as a window would. */
function fake(): { transport: Transport; calls: Map<string, Handler> } {
  const calls = new Map<string, Handler>();
  return {
    calls,
    transport: {
      handle: (channel, handler) => void calls.set(channel, handler),
      on: (channel, listener) => void calls.set(channel, listener)
    }
  };
}

const known = (candidate: unknown): string => (candidate === 'soul' ? 'soul' : '');

describe('recordingTransport', () => {
  it('records a call before its handler runs, and still runs the handler', () => {
    const order: string[] = [];
    const inner = fake();
    const wrapped = recordingTransport(
      inner.transport,
      () => order.push('recorded'),
      known,
      () => undefined
    );
    wrapped.handle(Invoke.startLoop, () => order.push('handled'));
    inner.calls.get(Invoke.startLoop)?.(caller, 'soul', 'black-caves');
    expect(order).toEqual(['recorded', 'handled']);
  });

  it('records a call whose handler throws', () => {
    const seen: string[] = [];
    const inner = fake();
    const wrapped = recordingTransport(
      inner.transport,
      (_s, _t, text) => seen.push(text),
      known,
      () => undefined
    );
    wrapped.handle(Invoke.startLoop, () => {
      throw new Error('refused');
    });
    expect(() => inner.calls.get(Invoke.startLoop)?.(caller, 'soul', 'x')).toThrow('refused');
    expect(seen).toEqual([`${Invoke.startLoop} "x"`]);
  });

  it('names the session and leaves it out of the text', () => {
    const seen: Array<[string, string]> = [];
    const inner = fake();
    const wrapped = recordingTransport(
      inner.transport,
      (s, _t, text) => seen.push([s, text]),
      known,
      () => undefined
    );
    wrapped.handle(Invoke.stopMoving, () => undefined);
    inner.calls.get(Invoke.stopMoving)?.(caller, 'soul');
    expect(seen).toEqual([['soul', Invoke.stopMoving]]);
  });

  it('records a call about no session against the client', () => {
    const seen: Array<[string, string]> = [];
    const inner = fake();
    const wrapped = recordingTransport(
      inner.transport,
      (s, _t, text) => seen.push([s, text]),
      known,
      () => undefined
    );
    wrapped.handle(Invoke.saveGlobal, () => undefined);
    inner.calls.get(Invoke.saveGlobal)?.(caller, { logging: {}, ui: {} });
    expect(seen).toEqual([['', `${Invoke.saveGlobal} {logging,ui}`]]);
  });

  it('does not record a read that happens many times a second', () => {
    const seen: string[] = [];
    const inner = fake();
    const wrapped = recordingTransport(
      inner.transport,
      (_s, _t, text) => seen.push(text),
      known,
      () => undefined
    );
    wrapped.handle(Invoke.getState, () => undefined);
    wrapped.on(Send.resize, () => undefined);
    inner.calls.get(Invoke.getState)?.(caller, 'soul');
    inner.calls.get(Send.resize)?.(caller, 'soul', 80, 24);
    expect(seen).toEqual([]);
  });
});

describe('a recorder that fails', () => {
  it('still runs the handler and says so', () => {
    const problems: string[] = [];
    const ran: string[] = [];
    const inner = fake();
    const wrapped = recordingTransport(
      inner.transport,
      () => {
        throw new Error('disk gone');
      },
      known,
      (message) => problems.push(message)
    );
    wrapped.handle(Invoke.startLoop, () => ran.push('handled'));
    inner.calls.get(Invoke.startLoop)?.(caller, 'soul', 'x');
    expect(ran).toEqual(['handled']);
    expect(problems).toEqual([`Could not record ${Invoke.startLoop}: disk gone`]);
  });
});

describe('describeCall', () => {
  it('never carries what a person typed', () => {
    expect(describeCall(Send.input, ['hunter2\r'])).toBe(`${Send.input} (8 chars)`);
  });

  it('shows an object as its keys, so a settings write carries no credential', () => {
    expect(describeCall(Invoke.saveProfile, [{ account: { password: 'x' } }])).toBe(
      `${Invoke.saveProfile} {account}`
    );
  });
});
