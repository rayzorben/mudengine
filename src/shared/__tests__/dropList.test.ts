import { describe, expect, it } from 'vitest';

import { dropListNames, withDropped } from '../dropList';

describe('the auto-drop list', () => {
  it('names a thing by the rule the server reads a typed name with', () => {
    expect(dropListNames(['rusty'], 'rusty dagger')).toBe(true);
    expect(dropListNames(['dagger'], 'rusty dagger')).toBe(true);
    expect(dropListNames(['Rusty Dagger'], 'rusty dagger')).toBe(true);
    expect(dropListNames(['rusty dagger'], 'dagger')).toBe(false);
    expect(dropListNames([''], 'rusty dagger')).toBe(false);
  });

  it('adds the name once, so a second click writes nothing new', () => {
    const once = withDropped(['torch'], 'rusty dagger', true);
    expect(once).toEqual(['torch', 'rusty dagger']);
    expect(withDropped(once, 'rusty dagger', true)).toEqual(once);
    expect(withDropped(['rusty'], 'rusty dagger', true)).toEqual(['rusty']);
  });

  it('takes off every entry the thing answers to, and nothing else', () => {
    expect(withDropped(['rusty', 'torch', 'rusty dagger'], 'rusty dagger', false)).toEqual([
      'torch'
    ]);
    expect(withDropped(['torch'], 'rusty dagger', false)).toEqual(['torch']);
  });
});
