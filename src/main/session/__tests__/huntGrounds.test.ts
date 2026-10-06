import { describe, expect, it } from 'vitest';

import { admitsFiller } from '../huntGrounds';

describe('a filler beside a ring', () => {
  const lair = (closes: boolean, respawn: number | null = 60) => ({
    respawn,
    group: { via: 'lair' as const },
    closes
  });

  it('is a lair on a clock', () => {
    expect(admitsFiller({ closes: false }, lair(false))).toBe(true);
    expect(admitsFiller({ closes: false }, lair(false, null))).toBe(false);
    expect(admitsFiller({ closes: false }, undefined)).toBe(false);
  });

  /* 2026-10-06: a ring outside Newhaven's Arena would have taken the cave bears inside it as filler. */
  it('is never one the next training shuts, for a ring that stays open', () => {
    expect(admitsFiller({ closes: false }, lair(true))).toBe(false);
    expect(admitsFiller({ closes: true }, lair(true))).toBe(true);
  });
});
