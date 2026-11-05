import { describe, expect, it } from 'vitest';

import { GROUNDS, admitsFiller, type Ground } from '../huntGrounds';
import type { HuntingConstants } from '../../../shared/hunting';
import type { WorldRoom } from '../../../shared/world';

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

describe('a room the wire saw refill', () => {
  const c = { greatermudRespawnOffsetSeconds: 30, roomRegenSeconds: 121 } as HuntingConstants;
  // The Newhaven Arena as the stock MajorMUD data states it: no lair, `Delay` 5.
  const arena = { map: 1, room: 2150, name: 'Newhaven, Arena', exits: {}, delay: 5 } as WorldRoom;
  const ground = (timed: number | null, made: boolean): Ground => ({
    room: arena,
    at: '1/2150',
    came: ['lashworm'],
    timed,
    arena: made
  });

  it('runs on its timed clock once it has one', () => {
    expect(GROUNDS.seen.stated(ground(2.5, true), [], 'majormud', c)).toEqual({
      clock: 'timed',
      respawn: 2.5
    });
  });

  /* themajorbbs's arena refilled 0.01 s or 5 s after each kill, against its stated 5. */
  it('reads an arena’s `Delay` in seconds before it is timed', () => {
    expect(GROUNDS.seen.stated(ground(null, true), [], 'majormud', c)).toEqual({
      clock: 'delay',
      respawn: 5
    });
  });
});
