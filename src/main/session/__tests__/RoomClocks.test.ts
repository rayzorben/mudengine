import { describe, expect, it } from 'vitest';

import { RoomClocks } from '../RoomClocks';
import { NO_SPAWNS, SPAWNS_VERSION, type LearnedSpawns } from '../../../shared/spawns';

const timed = (refills: number[]): LearnedSpawns => ({
  refills,
  seen: { rat: 1 },
  at: 0,
  v: SPAWNS_VERSION
});
/** Timed before moves were accounted for: a lair still reads it, a room with no lair does not. */
const before = (refills: number[]): LearnedSpawns => ({ refills, seen: { rat: 1 }, at: 0 });

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

  it('leaves a lair’s sub-second gaps out of its clock and the usual one', () => {
    // A lair's second monster, read within a second of the first one's death (orohost, 2026-10-03).
    const subject = clocks({
      '1/1': timed([0.5, 0.6, 0.55, 69, 70, 68]),
      '1/2': timed([0.4, 0.6, 0.5])
    });
    expect(subject.lairClock(['1/1'], isLair, false)).toEqual({ seconds: 69, whose: 'timed' });
    expect(subject.lairClock(['1/3'], isLair, true)).toEqual({ seconds: 69, whose: 'usual' });
  });

  it('lists a room with no lair that kept refilling, with who came', () => {
    const subject = clocks({
      '1/1': timed([20, 20, 20]),
      '1/9': timed([0, 1, 0]),
      '1/8': timed([5])
    });
    expect(subject.refilling(isLair)).toEqual([{ room: '1/9', clock: 0, names: ['rat'] }]);
  });

  /* 2026-10-04: thugs and orc rogues came into the Darkwood Main Road's 1/1392 twelve times, and Vaelor died there ten. */
  it('names who came into a road often enough to price a walk past them, and nobody where it is thin', () => {
    const subject = clocks({
      '1/1392': {
        refills: [0.5, 0.6, 0.7],
        seen: { 'orc rogue': 3, 'fierce thug': 7 },
        at: 0,
        v: SPAWNS_VERSION
      },
      '1/8': timed([5])
    });
    expect(subject.wanderers('1/1392')).toEqual(['fierce thug', 'orc rogue']);
    expect(subject.wanderers('1/8')).toBeNull();
    expect(subject.wanderers('1/77')).toBeNull();
  });

  /* 2026-10-06: the next room's spawn on entry was timed as this one refilling, in every corridor beside a lair. */
  it('reads a room with no lair only from refills timed with the moves accounted for', () => {
    const subject = clocks({ '1/9': before([0.5, 0.6, 0.55]), '1/1': before([20, 21, 22]) });
    expect(subject.refilling(isLair)).toEqual([]);
    expect(subject.wanderers('1/9')).toBeNull();
    expect(subject.seenIn('1/9')).toEqual([]);
    expect(clocks({ '1/9': timed([0.5, 0.6, 0.55]) }).seenIn('1/9')).toEqual(['rat']);
    expect(subject.lairClock(['1/1'], isLair, false)).toEqual({ seconds: 21, whose: 'timed' });
  });
});
