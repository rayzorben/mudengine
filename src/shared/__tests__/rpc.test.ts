import { describe, expect, it } from 'vitest';

import { asRpcFrame, asRpcInbound, trimArgs } from '../rpc';

/*
 * Both ends of the web transport parse what they are sent. A message that
 * does not fit is `null`, and the connection that sent it is closed rather
 * than answered in a shape nobody expects.
 */
describe('asRpcInbound', () => {
  it('accepts a numbered send and invoke', () => {
    expect(asRpcInbound({ k: 'send', q: 1, c: 'session:input', a: ['smoke', 'n\r'] })).toEqual({
      k: 'send',
      q: 1,
      c: 'session:input',
      a: ['smoke', 'n\r']
    });
    expect(asRpcInbound({ k: 'invoke', q: 2, id: 7, c: 'session:connect', a: ['smoke'] })).toEqual({
      k: 'invoke',
      q: 2,
      id: 7,
      c: 'session:connect',
      a: ['smoke']
    });
  });

  it('refuses a request without its number, since a resend could not be told apart', () => {
    expect(asRpcInbound({ k: 'send', c: 'session:input', a: [] })).toBeNull();
    expect(asRpcInbound({ k: 'send', q: 0, c: 'session:input', a: [] })).toBeNull();
    expect(asRpcInbound({ k: 'invoke', q: 1.5, id: 1, c: 'x', a: [] })).toBeNull();
  });

  it('accepts a first hello and a returning one, and nothing between', () => {
    expect(asRpcInbound({ k: 'hello', tab: null, key: null, last: 0 })).toEqual({
      k: 'hello',
      tab: null,
      key: null,
      last: 0
    });
    expect(asRpcInbound({ k: 'hello', tab: 3, key: 'k', last: 41 })).toEqual({
      k: 'hello',
      tab: 3,
      key: 'k',
      last: 41
    });
    expect(asRpcInbound({ k: 'hello', tab: 3, key: null, last: 0 })).toBeNull();
    expect(asRpcInbound({ k: 'hello', tab: 3, key: '', last: 0 })).toBeNull();
    expect(asRpcInbound({ k: 'hello', tab: null, key: null, last: -1 })).toBeNull();
  });

  it('accepts an ack', () => {
    expect(asRpcInbound({ k: 'ack', n: 12 })).toEqual({ k: 'ack', n: 12 });
    expect(asRpcInbound({ k: 'ack', n: 'x' })).toBeNull();
  });

  it('refuses what is not a message, or not ours in shape', () => {
    expect(asRpcInbound(null)).toBeNull();
    expect(asRpcInbound('session:input')).toBeNull();
    expect(asRpcInbound([])).toBeNull();
    expect(asRpcInbound({ k: 'push', n: 1, c: 'session:data', p: {} })).toBeNull();
    expect(asRpcInbound({ k: 'invoke', q: 1, id: 0, c: 'x', a: [] })).toBeNull();
    expect(asRpcInbound({ k: 'send', q: 1, c: 'Session:Input', a: [] })).toBeNull();
    expect(asRpcInbound({ k: 'send', q: 1, c: 'a'.repeat(65), a: [] })).toBeNull();
    expect(asRpcInbound({ k: 'send', q: 1, c: 'session:input', a: 'n' })).toBeNull();
  });

  it('keeps only the fields it declares', () => {
    const parsed = asRpcInbound({ k: 'send', q: 1, c: 'x', a: [], extra: 'smuggled' });
    expect(parsed).toEqual({ k: 'send', q: 1, c: 'x', a: [] });
  });
});

describe('asRpcFrame', () => {
  it('accepts a numbered push, result and failure', () => {
    expect(asRpcFrame({ k: 'push', n: 1, c: 'session:data', p: { seq: 1 } })).toEqual({
      k: 'push',
      n: 1,
      c: 'session:data',
      p: { seq: 1 }
    });
    expect(asRpcFrame({ k: 'reply', n: 2, id: 3, r: 42 })).toEqual({
      k: 'reply',
      n: 2,
      id: 3,
      r: 42
    });
    expect(asRpcFrame({ k: 'reply', n: 2, id: 3, e: 'no' })).toEqual({
      k: 'reply',
      n: 2,
      id: 3,
      e: 'no'
    });
  });

  it('carries an absent result as undefined, which is what a void handler answers', () => {
    const parsed = asRpcFrame({ k: 'reply', n: 1, id: 3 });
    expect(parsed).not.toBeNull();
    expect(parsed && 'r' in parsed ? parsed.r : 'missing').toBeUndefined();
  });

  it('refuses a push or reply without its number', () => {
    expect(asRpcFrame({ k: 'push', c: 'session:data', p: 1 })).toBeNull();
    expect(asRpcFrame({ k: 'reply', n: 0, id: 3, r: 1 })).toBeNull();
  });

  it('accepts a welcome and a beat', () => {
    expect(asRpcFrame({ k: 'welcome', tab: 2, key: 'k', resumed: true, got: 0 })).toEqual({
      k: 'welcome',
      tab: 2,
      key: 'k',
      resumed: true,
      got: 0
    });
    expect(asRpcFrame({ k: 'beat', next: 10000, got: 4 })).toEqual({
      k: 'beat',
      next: 10000,
      got: 4
    });
    expect(asRpcFrame({ k: 'beat', next: 0, got: 0 })).toBeNull();
    expect(asRpcFrame({ k: 'beat', next: Infinity, got: 0 })).toBeNull();
    expect(asRpcFrame({ k: 'welcome', tab: 2, key: 'k', resumed: 'yes', got: 0 })).toBeNull();
  });

  it('refuses the request shapes and everything else', () => {
    expect(asRpcFrame({ k: 'send', q: 1, c: 'x', a: [] })).toBeNull();
    expect(asRpcFrame({ k: 'hello', tab: null, key: null, last: 0 })).toBeNull();
    expect(asRpcFrame({ k: 'push', n: 1, c: '', p: 1 })).toBeNull();
    expect(asRpcFrame(undefined)).toBeNull();
  });
});

describe('trimArgs', () => {
  it('drops trailing undefineds so JSON cannot turn an absent target into null', () => {
    expect(trimArgs(['smoke', undefined])).toEqual(['smoke']);
    expect(trimArgs(['smoke', undefined, undefined])).toEqual(['smoke']);
    expect(trimArgs([])).toEqual([]);
  });

  it('keeps an interior undefined and a trailing null', () => {
    expect(trimArgs(['a', undefined, 'c'])).toEqual(['a', undefined, 'c']);
    expect(trimArgs(['a', null])).toEqual(['a', null]);
  });
});
