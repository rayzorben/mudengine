import { describe, expect, it } from 'vitest';

import { extensionMessage } from '../extensions';

describe('what an extension’s page may say', () => {
  it('is that it has loaded, or a button with its arguments', () => {
    expect(extensionMessage({ type: 'mudengine:ready' })).toEqual({ type: 'mudengine:ready' });
    expect(
      extensionMessage({ type: 'mudengine:action', id: 3, action: 'pause', args: [1] })
    ).toEqual({ type: 'mudengine:action', id: 3, action: 'pause', args: [1] });
    expect(extensionMessage({ type: 'mudengine:action', id: 4, action: 'ask' })).toEqual({
      type: 'mudengine:action',
      id: 4,
      action: 'ask',
      args: []
    });
  });

  it('is nothing else', () => {
    expect(extensionMessage('pause')).toBeNull();
    expect(extensionMessage({ type: 'mudengine:action', id: '3', action: 'pause' })).toBeNull();
    expect(extensionMessage({ type: 'other' })).toBeNull();
  });
});
