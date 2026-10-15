import { describe, expect, it } from 'vitest';

import { FightClock } from '../fightClock';

/* Todo 124: the engagement's wait and the gap after a kill, for the fight record. */
describe('the fight clock', () => {
  it('times the engagement to the first swing, once', () => {
    const clock = new FightClock();
    clock.engage(1000, '1/1');
    clock.swung(3000);
    clock.swung(8000);
    expect(clock.take(10_000)).toEqual({ engageMs: 2000 });
    // Taken: the next fight carries nothing of this engagement.
    expect(clock.take(10_000)).toEqual({});
  });

  it('times the gap from a kill to the next engagement in the same room', () => {
    const clock = new FightClock();
    clock.killed(10_000, '1/1');
    clock.engage(12_500, '1/1');
    clock.swung(12_500);
    expect(clock.take(10_000)).toEqual({ engageMs: 0, afterKillMs: 2500 });
  });

  it('times one gap a kill, so a fight with no kill does not stretch the next', () => {
    const clock = new FightClock();
    clock.killed(0, '1/1');
    clock.engage(2000, '1/1');
    expect(clock.take(10_000)).toEqual({ afterKillMs: 2000 });
    clock.engage(8000, '1/1');
    expect(clock.take(10_000)).toEqual({});
  });

  it('leaves out a gap in another room, past the most, or after an unplaced kill', () => {
    const clock = new FightClock();
    clock.killed(10_000, '1/1');
    clock.engage(12_000, '1/2');
    expect(clock.take(10_000)).toEqual({});
    clock.engage(30_000, '1/1');
    expect(clock.take(10_000)).toEqual({});
    clock.killed(40_000, null);
    clock.engage(41_000, '1/1');
    expect(clock.take(10_000)).toEqual({});
  });

  it('times no swing seen before any engagement', () => {
    const clock = new FightClock();
    clock.swung(500);
    clock.engage(1000, null);
    expect(clock.take(10_000)).toEqual({});
  });
});
