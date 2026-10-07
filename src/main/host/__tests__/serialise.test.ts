import { describe, expect, it, vi } from 'vitest';

import { serialise } from '../serialise';

describe('what a host sends a window', () => {
  it('is JSON text, nothing sent as null', () => {
    expect(serialise({ session: 's1', payload: [1] }, 'a push')).toEqual({
      text: '{"session":"s1","payload":[1]}',
      error: null
    });
    expect(serialise(undefined, 'a push').text).toBe('null');
  });

  it('says what could not be carried, and sends nothing', () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    const looped: Record<string, unknown> = {};
    looped['self'] = looped;
    const result = serialise(looped, 'a push on session:character');
    expect(result.text).toBeNull();
    expect(result.error).not.toBeNull();
    expect(said.mock.calls[0]?.[0]).toContain('a push on session:character');
    said.mockRestore();
  });
});
