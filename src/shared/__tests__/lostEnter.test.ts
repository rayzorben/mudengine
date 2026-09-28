import { describe, expect, it } from 'vitest';

import { LOST_ENTER_CONTROL_MAX, asLostEnter } from '../types';

describe('a lost Enter crossing the bridge', () => {
  it('reads what the window reported', () => {
    expect(asLostEnter({ place: 'console', control: null, code: 229 })).toEqual({
      place: 'console',
      control: null,
      code: 229
    });
    expect(asLostEnter({ place: 'control', control: 'the Stop button', code: 13 })).toEqual({
      place: 'control',
      control: 'the Stop button',
      code: 13
    });
  });

  it('refuses a place outside the list, or a key code that is not a whole number', () => {
    expect(asLostEnter({ place: 'terminal', control: null, code: 13 })).toBeNull();
    expect(asLostEnter({ place: 'console', control: null, code: '13' })).toBeNull();
    expect(asLostEnter(null)).toBeNull();
  });

  it('bounds a control description before it reaches the file', () => {
    const long = asLostEnter({
      place: 'control',
      control: 'x'.repeat(LOST_ENTER_CONTROL_MAX + 300),
      code: 13
    });
    expect(long?.control).toHaveLength(LOST_ENTER_CONTROL_MAX);
  });
});
