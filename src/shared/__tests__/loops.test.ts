import { describe, expect, it } from 'vitest';

import {
  asLoops,
  dueStop,
  loopCategory,
  nextStop,
  sameLoops,
  splitStop,
  UNCATEGORISED,
  type Loop
} from '../loops';

describe('reading a loop out of the options file', () => {
  it('takes a bare list of room names', () => {
    const [loop] = asLoops([
      { name: 'Arena', stops: ['Newhaven, Arena', 'Newhaven, Narrow Road'] }
    ]);
    expect(loop?.name).toBe('Arena');
    expect(loop?.stops).toEqual([{ room: 'Newhaven, Arena' }, { room: 'Newhaven, Narrow Road' }]);
  });

  it('reads a route this character prefers, and nothing else as one', () => {
    const loops = asLoops([
      { name: 'To the bank', stops: ['A', 'B'], bounce: true, prefer: true },
      { name: 'Sewers', stops: ['A', 'B'], prefer: 'yes' }
    ]);
    expect(loops[0]).toMatchObject({ bounce: true, prefer: true });
    expect(loops[1]).not.toHaveProperty('prefer');
  });

  it('takes a stop with a linger, and clamps it', () => {
    const [loop] = asLoops([
      {
        name: 'L',
        stops: [
          { room: 'A', linger: 30.6 },
          { room: 'B', linger: 9000 },
          { room: 'C', linger: -5 }
        ]
      }
    ]);
    expect(loop?.stops).toEqual([
      { room: 'A', linger: 31 },
      { room: 'B', linger: 600 },
      { room: 'C' }
    ]);
  });

  it('drops a loop that is not one', () => {
    // No name, no stops, not an object: none of these is a loop. One stop is
    // a camp and is kept (todo 108).
    expect(asLoops([{ name: '', stops: ['A', 'B'] }])).toEqual([]);
    expect(asLoops([{ name: 'L', stops: ['A'] }]).map((loop) => loop.stops)).toEqual([
      [{ room: 'A' }]
    ]);
    expect(asLoops([{ name: 'L' }])).toEqual([]);
    expect(asLoops(['nope'])).toEqual([]);
    expect(asLoops('nope')).toEqual([]);
  });
});

describe('naming a room a loop visits', () => {
  it('reads coordinates off the end when the name is shared', () => {
    expect(splitStop({ room: 'Town Gates 1/2150' })).toEqual({
      name: 'Town Gates',
      at: { map: 1, room: 2150 }
    });
    expect(splitStop({ room: 'Newhaven, Arena' })).toEqual({ name: 'Newhaven, Arena', at: null });
  });
});

describe('where a loop goes next', () => {
  const ring: Loop = { name: 'r', stops: [{ room: 'A' }, { room: 'B' }, { room: 'C' }] };
  const there: Loop = { ...ring, bounce: true };

  it('rings round to the start', () => {
    expect(nextStop(ring, 0, true)).toEqual({ index: 1, forward: true });
    expect(nextStop(ring, 2, true)).toEqual({ index: 0, forward: true });
  });

  it('bounces back down a corridor instead of jumping to the far end', () => {
    expect(nextStop(there, 1, true)).toEqual({ index: 2, forward: true });
    expect(nextStop(there, 2, true)).toEqual({ index: 1, forward: false });
    expect(nextStop(there, 1, false)).toEqual({ index: 0, forward: false });
    expect(nextStop(there, 0, false)).toEqual({ index: 1, forward: true });
  });
});

/*
 * A stop may carry the clock of the room it names, and the lap walks it only
 * when that clock has come round (todo 15). The Hunting card already prices a
 * slow filler as entered on some laps and not others; before this the runner
 * walked its detour on every one, so the rate the card promised was not the
 * rate the lap earned.
 */
describe('which stop is worth walking to', () => {
  /** The user's own example: two rooms on 30 seconds, a third on 60. */
  const clocked: Loop = {
    name: 'r',
    stops: [
      { room: 'A', every: 30 },
      { room: 'B', every: 30 },
      { room: 'C', every: 60 }
    ]
  };
  const plain: Loop = { name: 'r', stops: [{ room: 'A' }, { room: 'B' }, { room: 'C' }] };
  const at = (seconds: number): number => seconds * 1000;

  /* With nothing clocked, this is `nextStop` and nothing else: a loop written
     by hand walks exactly as it was written. */
  it('walks the list as written when no stop states a clock', () => {
    expect(dueStop(plain, 0, true, new Map(), at(0))).toEqual({
      index: 1,
      forward: true,
      lapped: false
    });
    expect(dueStop(plain, 2, true, new Map(), at(0))).toEqual({
      index: 0,
      forward: true,
      lapped: true
    });
  });

  /* A stop the client has never cleared has no elapsed time to judge by, so it
     is walked rather than guessed at. */
  it('walks a stop it has never cleared', () => {
    expect(dueStop(clocked, 0, true, new Map([['A', at(0)]]), at(1)).index).toBe(1);
  });

  /* The whole of the todo: standing in B at 20s with A cleared at 0 and C at
     20, nothing is due — so the soonest is taken (A, at 30) rather than the
     next in the list (C, at 80), whose detour would earn nothing. */
  it('takes the stop whose clock comes round soonest when none is due', () => {
    const cleared = new Map([
      ['A', at(0)],
      ['B', at(10)],
      ['C', at(20)]
    ]);
    expect(dueStop(clocked, 1, true, cleared, at(20))).toEqual({
      index: 0,
      forward: true,
      lapped: true
    });
  });

  /* And once the slow one has come round it is walked, in its own place. */
  it('walks the slow stop once its clock has come round', () => {
    const cleared = new Map([
      ['A', at(60)],
      ['B', at(70)],
      ['C', at(20)]
    ]);
    expect(dueStop(clocked, 1, true, cleared, at(85)).index).toBe(2);
  });

  /* A skipped stop is not a visit, and the lap counter is answered by the scan
     that skipped it — a loop of three rooms must not report laps it never
     walked. */
  it('counts the lap from the stops it passed over, not from the one it took', () => {
    const cleared = new Map([
      ['A', at(100)],
      ['B', at(0)],
      ['C', at(0)]
    ]);
    // Standing in C at 40s: A is not due until 130, B is due at 30.
    const next = dueStop(clocked, 2, true, cleared, at(40));
    expect(next.index).toBe(1);
    expect(next.lapped).toBe(true);
  });

  /* A bounce loop still bounces: the walking order is `nextStop`'s own. */
  it('keeps the shape of a bounce loop', () => {
    const corridor: Loop = { ...clocked, bounce: true };
    const cleared = new Map([
      ['A', at(0)],
      ['B', at(0)],
      ['C', at(0)]
    ]);
    expect(dueStop(corridor, 2, true, cleared, at(45))).toEqual({
      index: 1,
      forward: false,
      lapped: true
    });
  });

  /*
   * One stop whose clock has not come round: stay on it, and count the lap as
   * a one-room camp already counts it. The dwell is what waits — a camp steps
   * to the same stop and dwells again without a command leaving (todo 108).
   */
  it('stays on a single stop that is not due yet', () => {
    const camp: Loop = { name: 'c', stops: [{ room: 'A', every: 60 }] };
    expect(dueStop(camp, 0, true, new Map([['A', at(0)]]), at(10))).toEqual({
      index: 0,
      forward: true,
      lapped: true
    });
  });
});

/*
 * Limits are for a payload that crossed the IPC boundary, and *only* for that.
 * A file the player owns is read whole: a loop somebody spent an evening
 * recording must not lose its tail to a number chosen for a different caller.
 */
describe('how much of a list to keep', () => {
  const many = (count: number): unknown[] =>
    Array.from({ length: count }, (_, index) => ({
      name: `loop ${index}`,
      stops: ['A', 'B', 'C']
    }));

  it('keeps all of it for the options file, which nobody else wrote', () => {
    expect(asLoops(many(300))).toHaveLength(300);
  });

  it('stops at the ceiling for a payload from a window', () => {
    expect(asLoops(many(300), { loops: 10, stops: 500 })).toHaveLength(10);
  });

  it('bounds the stops as well, so one long list cannot slip through', () => {
    const long = [{ name: 'long', stops: Array.from({ length: 40 }, (_, at) => `room ${at}`) }];
    expect(asLoops(long, { loops: 10, stops: 5 })[0]?.stops).toHaveLength(5);
  });

  /* One stop is a camp (todo 108); a ceiling that cuts a loop to one keeps it
     as one, and a ceiling of none drops it. */
  it('keeps a loop the ceiling cut down to one stop, and drops one cut to none', () => {
    expect(
      asLoops([{ name: 'x', stops: ['A', 'B'] }], { loops: 10, stops: 1 }).map((loop) => loop.stops)
    ).toEqual([[{ room: 'A' }]]);
    expect(asLoops([{ name: 'x', stops: ['A', 'B'] }], { loops: 10, stops: 0 })).toEqual([]);
  });
});

/*
 * What decides whether a character's file has to *state* its loops at all.
 * `overlay` replaces lists rather than merging them, so writing a list
 * identical to the inherited one takes that character out of the shared one
 * for good — silently, on a save made for some other reason.
 */
describe('whether two lists of loops say the same thing', () => {
  const one: Loop = { name: 'sewers', stops: [{ room: 'A' }, { room: 'B' }] };

  it('sees the same list as the same', () => {
    expect(sameLoops([one], [{ ...one, stops: [{ room: 'A' }, { room: 'B' }] }])).toBe(true);
  });

  it('reads an absent linger and a zero one as the same absence', () => {
    expect(
      sameLoops([one], [{ name: 'sewers', stops: [{ room: 'A' }, { room: 'B', linger: 0 }] }])
    ).toBe(true);
  });

  it('sees a renamed, reordered, re-routed or turned-round loop as different', () => {
    expect(sameLoops([one], [{ ...one, name: 'tunnels' }])).toBe(false);
    expect(sameLoops([one], [{ ...one, stops: [{ room: 'B' }, { room: 'A' }] }])).toBe(false);
    expect(sameLoops([one], [{ ...one, stops: [{ room: 'A' }, { room: 'C' }] }])).toBe(false);
    expect(sameLoops([one], [{ ...one, bounce: true }])).toBe(false);
    expect(sameLoops([one], [{ ...one, prefer: true }])).toBe(false);
    expect(sameLoops([one], [{ ...one, stops: [{ room: 'A' }, { room: 'B', linger: 20 }] }])).toBe(
      false
    );
  });

  it('sees a longer or shorter list as different, and two empties as the same', () => {
    expect(sameLoops([one], [])).toBe(false);
    expect(sameLoops([], [])).toBe(true);
  });
});

/*
 * The group a loop is listed under, which the Loops modal draws as a heading.
 *
 * Derived from the name rather than stored, because MegaMUD's own 420 already
 * carry it — every one of them is `Area: Room-map room`, and they fall into 57
 * areas. The cases that matter are the ones a `split(':')` scattered through
 * the consumers would each get to decide for itself.
 */
describe('the area a loop is grouped under', () => {
  it('takes the prefix before the colon', () => {
    expect(loopCategory('Ancient Fortress: Alabaster Palace, North End-17 9670')).toBe(
      'Ancient Fortress'
    );
    expect(loopCategory("Dragon's Teeth Hills: Cave-9 100")).toBe("Dragon's Teeth Hills");
  });

  /* A name with two colons is an area and then a room whose own name has one.
     Taking the last would make the room the group. */
  it('splits on the first colon, never the last', () => {
    expect(loopCategory('A: B: C')).toBe('A');
  });

  /* The commonest shape for a loop somebody wrote by hand — and a blank
     heading over a run of rows reads as a fault rather than as the answer. */
  it('calls a name with no area uncategorised, never blank', () => {
    expect(loopCategory('Sewer circuit')).toBe(UNCATEGORISED);
    expect(loopCategory(': leading colon')).toBe(UNCATEGORISED);
    expect(loopCategory('   : spaces')).toBe(UNCATEGORISED);
  });

  it('gives every parsed loop one, so every row has a heading to sit under', () => {
    const loops = asLoops([
      { name: 'Sewers: Dark Cave-1 866', stops: ['A', 'B'] },
      { name: 'Sewer circuit', stops: ['A', 'B'] }
    ]);
    expect(loops.map((loop) => loop.category)).toEqual(['Sewers', UNCATEGORISED]);
  });

  /* For the loop whose area is not in its name. The file wins over the
     derivation, which is what makes the derivation a fallback. */
  it('lets a file state its own, overriding the name', () => {
    const [loop] = asLoops([
      { name: 'Sewers: Dark Cave-1 866', stops: ['A', 'B'], category: 'Mine' }
    ]);
    expect(loop?.category).toBe('Mine');
  });

  /*
   * A stated category is a real difference, and `sameLoops` has to see it.
   *
   * Comparing it looks like a tautology while every category is derived from
   * the name. It stops being one as soon as a file states its own: `sameLoops`
   * is `ConfigStore.setExtras`'s change detector, so an edit it calls "no
   * change" is a file that silently does not hot-reload — the modal would go on
   * grouping the loop under its old area until something unrelated forced a
   * reload.
   */
  it('is a real difference between two loops that share a name', () => {
    const [one] = asLoops([{ name: 'L', stops: ['A', 'B'], category: 'One' }]);
    const [two] = asLoops([{ name: 'L', stops: ['A', 'B'], category: 'Two' }]);
    expect(sameLoops([one as Loop], [two as Loop])).toBe(false);
  });

  /* And two that agree about it are still the same loop — the derived case,
     which is every loop nobody has stated one for. Load-bearing in the other
     direction: if this compared unequal, the store would recompose and
     republish the whole configuration on every poll. */
  it('leaves two loops that agree about it identical', () => {
    const [one] = asLoops([{ name: 'Sewers: A', stops: ['A', 'B'] }]);
    const [two] = asLoops([{ name: 'Sewers: A', stops: ['A', 'B'] }]);
    expect(sameLoops([one as Loop], [two as Loop])).toBe(true);
  });
});
