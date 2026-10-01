import { describe, expect, it } from 'vitest';

import { RoomClocks } from '../RoomClocks';
import { NO_SPAWNS, type LearnedSpawns } from '../../../shared/spawns';

const timed = (refills: number[]): LearnedSpawns => ({ refills, seen: { rat: 1 }, at: 0 });

function clocks(rooms: Record<string, LearnedSpawns>): RoomClocks {
  const table = new Map(Object.entries(rooms));
  return new RoomClocks({
    ...NO_SPAWNS,
    spawnsAt: (room) => table.get(room) ?? null,
    allSpawns: () => table
  });
}

const LAIRS = new Set(['1/1', '1/2', '1/3']);
const isLair = (room: string): boolean => LAIRS.has(room);

describe('the clocks the wire timed', () => {
  it('outranks a stated delay with the lair’s own timed clock, the shortest of its rooms', () => {
    const subject = clocks({ '1/1': timed([20, 21, 22]), '1/2': timed([40, 40, 40]) });
    expect(subject.lairClock(['1/1', '1/2'], isLair, false)).toEqual({
      seconds: 21,
      whose: 'timed'
    });
  });

  it('borrows the realm’s usual lair clock only where the database states none', () => {
    const subject = clocks({ '1/1': timed([20, 20, 20]), '1/9': timed([0, 0, 0]) });
    expect(subject.lairClock(['1/3'], isLair, false)).toBeNull();
    // The arena (1/9) is not a lair, so it does not set the usual.
    expect(subject.lairClock(['1/3'], isLair, true)).toEqual({ seconds: 20, whose: 'usual' });
  });

  it('lists a room with no lair that kept refilling, with who came', () => {
    const subject = clocks({
      '1/1': timed([20, 20, 20]),
      '1/9': timed([0, 1, 0]),
      '1/8': timed([5])
    });
    expect(subject.refilling(isLair)).toEqual([{ room: '1/9', clock: 0, names: ['rat'] }]);
  });
});
