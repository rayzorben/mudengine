import { describe, expect, it } from 'vitest';

import { asRpcOutbound, asRpcRequest, trimArgs } from '../rpc';

/**
 * The web transport's envelope is parsed at both ends, never trusted: a
 * browser tab is a client like any other. These are the shapes it accepts
 * and, more to the point, the ones it refuses.
 */
describe('asRpcRequest', () => {
  it('accepts a send and an invoke', () => {
    expect(asRpcRequest({ k: 'send', c: 'session:input', a: ['smoke', 'n\r'] })).toEqual({
      k: 'send',
      c: 'session:input',
      a: ['smoke', 'n\r']
    });
    expect(asRpcRequest({ k: 'invoke', id: 7, c: 'session:connect', a: ['smoke'] })).toEqual({
      k: 'invoke',
      id: 7,
      c: 'session:connect',
      a: ['smoke']
    });
  });

  it('refuses what is not a message', () => {
    expect(asRpcRequest(null)).toBeNull();
    expect(asRpcRequest('session:input')).toBeNull();
    expect(asRpcRequest([])).toBeNull();
    expect(asRpcRequest({ k: 'push', c: 'session:data', p: {} })).toBeNull();
    expect(asRpcRequest({ k: 'reply', id: 1, r: null })).toBeNull();
  });

  it('refuses an invoke without a usable id', () => {
    expect(asRpcRequest({ k: 'invoke', c: 'x', a: [] })).toBeNull();
    expect(asRpcRequest({ k: 'invoke', id: 0, c: 'x', a: [] })).toBeNull();
    expect(asRpcRequest({ k: 'invoke', id: 1.5, c: 'x', a: [] })).toBeNull();
    expect(asRpcRequest({ k: 'invoke', id: '1', c: 'x', a: [] })).toBeNull();
  });

  it('refuses a channel that is not one of ours in shape', () => {
    expect(asRpcRequest({ k: 'send', c: '', a: [] })).toBeNull();
    expect(asRpcRequest({ k: 'send', c: 'Session:Input', a: [] })).toBeNull();
    expect(asRpcRequest({ k: 'send', c: 'a'.repeat(65), a: [] })).toBeNull();
    expect(asRpcRequest({ k: 'send', c: 'session:input', a: 'n' })).toBeNull();
  });

  it('keeps only the fields it declares', () => {
    const parsed = asRpcRequest({ k: 'send', c: 'x', a: [], extra: 'smuggled' });
    expect(parsed).toEqual({ k: 'send', c: 'x', a: [] });
  });
});

describe('asRpcOutbound', () => {
  it('accepts a push, a result and a failure', () => {
    expect(asRpcOutbound({ k: 'push', c: 'session:data', p: { seq: 1 } })).toEqual({
      k: 'push',
      c: 'session:data',
      p: { seq: 1 }
    });
    expect(asRpcOutbound({ k: 'reply', id: 3, r: 42 })).toEqual({ k: 'reply', id: 3, r: 42 });
    expect(asRpcOutbound({ k: 'reply', id: 3, e: 'no' })).toEqual({ k: 'reply', id: 3, e: 'no' });
  });

  it('carries an absent result as undefined, which is what a void handler answers', () => {
    const parsed = asRpcOutbound({ k: 'reply', id: 3 });
    expect(parsed).not.toBeNull();
    expect(parsed && 'r' in parsed ? parsed.r : 'missing').toBeUndefined();
  });

  it('refuses the request shapes and everything else', () => {
    expect(asRpcOutbound({ k: 'send', c: 'x', a: [] })).toBeNull();
    expect(asRpcOutbound({ k: 'invoke', id: 1, c: 'x', a: [] })).toBeNull();
    expect(asRpcOutbound({ k: 'reply', id: 0, r: 1 })).toBeNull();
    expect(asRpcOutbound({ k: 'push', c: '', p: 1 })).toBeNull();
    expect(asRpcOutbound(undefined)).toBeNull();
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
