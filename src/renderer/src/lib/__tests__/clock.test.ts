import { describe, expect, it } from 'vitest';

import { clock } from '../clock';

describe('clock', () => {
  it('reads as the per-call formatter it replaced', () => {
    for (const at of [0, 1_758_700_800_000, 1_758_743_999_000, Date.now()]) {
      expect(clock(at)).toBe(new Date(at).toLocaleTimeString(undefined, { hour12: false }));
    }
  });
});
