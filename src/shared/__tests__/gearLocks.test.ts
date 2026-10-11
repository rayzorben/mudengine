import { describe, expect, it } from 'vitest';
import type { CarriedItem } from '../character';
import { wireItem } from '../entities';
import type { Loadout } from '../gear';
import { allowanceLeft, expiredSlots, freeLoadout, lockLoadout, releaseSlots } from '../gearLocks';
import { NO_TALLY, playedFor } from '../tally';

const HOUR = 3_600_000;
const free: Loadout = [
  { slot: 'Finger', item: 'gold ring', at: 1, locked: null },
  { slot: 'Head', item: 'padded helm', at: 1, locked: null },
  { slot: 'Neck', item: 'gold ring', at: 1, locked: null }
];

function carried(name: string, over: Partial<CarriedItem> = {}): CarriedItem {
  return { ...wireItem(name), ...over };
}

describe('gear locks', () => {
  it('locks only what is free, so a second death keeps the first lock', () => {
    const once = lockLoadout(free, 10, 0);
    const twice = lockLoadout(releaseSlots(once, ['Head']), 20, 5);
    expect(twice.map((worn) => worn.locked?.at)).toEqual([10, 20, 10]);
  });

  it('is the same loadout when nothing is free to lock or held to free', () => {
    const held = lockLoadout(free, 10, 0);
    expect(lockLoadout(held, 20, 0)).toBe(held);
    expect(freeLoadout(free, [carried('gold ring')])).toBe(free);
  });

  it('frees one slot per carried copy', () => {
    const held = lockLoadout(free, 10, 0);
    const one = freeLoadout(held, [carried('gold ring')]);
    expect(one.map((worn) => worn.locked === null)).toEqual([true, false, false]);
    const two = freeLoadout(held, [carried('gold ring'), carried('gold ring')]);
    expect(two.map((worn) => worn.locked === null)).toEqual([true, false, true]);
  });

  it('keeps a slot a different worn item fills', () => {
    const held = lockLoadout(free, 10, 0);
    const items = [carried('padded helm'), carried('iron helm', { equipped: true, slot: 'Head' })];
    expect(freeLoadout(held, items)[1]?.locked).not.toBeNull();
  });

  it('runs the allowance on play time from each lock', () => {
    const held = lockLoadout(free.slice(0, 2), 10, 0);
    expect(expiredSlots(held, 3 * HOUR - 1, 3 * HOUR)).toEqual([]);
    expect(expiredSlots(held, 3 * HOUR, 3 * HOUR)).toHaveLength(2);
    expect(allowanceLeft(held, HOUR, 3 * HOUR)).toBe(2 * HOUR);
    expect(allowanceLeft(free, HOUR, 3 * HOUR)).toBeNull();
  });

  it('counts fights and walking as play, never resting or standing', () => {
    const tally = {
      ...NO_TALLY,
      engagedMs: HOUR,
      spent: { moving: 2 * HOUR, resting: 5 * HOUR, meditating: 4 * HOUR },
      doing: { what: 'resting' as const, since: 0 }
    };
    expect(playedFor(tally, 10 * HOUR)).toBe(3 * HOUR);
    expect(playedFor({ ...tally, engagedSince: 9 * HOUR, doing: null }, 10 * HOUR)).toBe(4 * HOUR);
  });
});
