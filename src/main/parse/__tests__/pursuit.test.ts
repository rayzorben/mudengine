import { describe, expect, it } from 'vitest';

import { Pursuit } from '../pursuit';

// As `mob-arrives-room` reads it: the name and verb in `line`, the way in in `direction`.
const arrives = (text: string, direction: string, at: number) => ({
  type: 'mob-arrives-room' as const,
  text,
  groups: { line: text.replace(/ into the room from .*$/, ''), direction },
  at
});

/* The follow line is GreaterMUD's `Mob.GetMobFollowMessage`; captures carry 82 of its shape. */
describe('a monster following the character', () => {
  it('walks in from the way back with what it carried', () => {
    const pursuit = new Pursuit<number>();
    pursuit.park('orc sentry', 40, 'n', 30_000);
    expect(
      pursuit.arrived(arrives('orc sentry moves into the room from the south.', 'south', 1_000))
    ).toEqual({
      key: 'orc sentry',
      value: 40
    });
    // Taken once: a second orc sentry walking in is somebody else.
    expect(
      pursuit.arrived(arrives('orc sentry moves into the room from the south.', 'south', 1_100))
    ).toBeNull();
  });

  it('is not a monster walking in from anywhere else, or too late', () => {
    const pursuit = new Pursuit<number>();
    pursuit.park('orc sentry', 40, 'n', 30_000);
    expect(
      pursuit.arrived(arrives('orc sentry moves into the room from the east.', 'east', 1_000))
    ).toBeNull();
    expect(
      pursuit.arrived(arrives('orc sentry moves into the room from the south.', 'south', 31_000))
    ).toBeNull();
  });

  it('is expected from the latest way back after another step, and let go after a teleport', () => {
    const pursuit = new Pursuit<number>();
    pursuit.park('constrictor', 12, 'n', 30_000);
    pursuit.stepped('e', 2_000);
    expect(
      pursuit.arrived(arrives('constrictor moves into the room from the south.', 'south', 2_500))
    ).toBeNull();
    expect(
      pursuit.arrived(arrives('constrictor moves into the room from the west.', 'west', 2_600))
    ).toEqual({
      key: 'constrictor',
      value: 12
    });
    pursuit.park('constrictor', 12, 'n', 30_000);
    expect(pursuit.stepped(null, 3_000)).toEqual([12]);
    expect(
      pursuit.arrived(arrives('constrictor moves into the room from the south.', 'south', 3_100))
    ).toBeNull();
  });

  it('reads an article and above or below', () => {
    const pursuit = new Pursuit<number>();
    pursuit.park('giant crab', 5, 'u', 30_000);
    expect(
      pursuit.arrived(arrives('The giant crab moves into the room from below.', 'below', 10))
    ).toEqual({
      key: 'giant crab',
      value: 5
    });
  });
});
