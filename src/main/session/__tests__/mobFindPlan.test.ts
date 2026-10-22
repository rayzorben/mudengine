import { describe, expect, it } from 'vitest';

import { planMobFind, type MobFindParts } from '../mobFindPlan';
import type { Traveller } from '../../world/WorldGraph';
import type { RoomId, WorldMob } from '../../../shared/world';
import { tuning } from '../../app/tuning';

/** A corridor a - b - c - d, the character in a; e is off every way. */
const MOVES: Record<string, number> = { a: 0, b: 1, c: 2, d: 3 };

const GRAVEDIGGER: WorldMob = { name: 'gravedigger', hp: 100, regenHours: 1 } as WorldMob;

function parts(
  lairs: RoomId[],
  mob: WorldMob | null = GRAVEDIGGER,
  here: RoomId | null = 'a'
): MobFindParts {
  return {
    here: () => here,
    world: () => ({
      mob: () => mob ?? undefined,
      lairRoomsOf: () => lairs,
      byId: (room) => ({ name: `the ${room}` }) as never,
      sweepTo: (from, wanted) =>
        new Map(
          [...wanted]
            .filter((room) => room in MOVES)
            .map((room) => {
              const moves = Math.abs(MOVES[room]! - (MOVES[from] ?? 0));
              return [room, { cost: moves, moves }];
            })
        )
    }),
    traveller: () => ({}) as Traveller
  };
}

describe('the rooms a find walks', () => {
  it('orders the lairs from where the character stands, counting the moves, and lists the unreached', () => {
    const plan = planMobFind(parts(['d', 'b', 'e']), 'gravedigger');
    expect(plan).toMatchObject({
      mob: 'gravedigger',
      regenHours: 1,
      rooms: ['b', 'd'],
      steps: 3,
      unreached: ['e']
    });
  });

  it('refuses a name the realm has no row for, and an empty one', () => {
    expect(typeof planMobFind(parts(['b', 'c'], null), 'nobody')).toBe('string');
    expect(typeof planMobFind(parts(['b', 'c']), '  ')).toBe('string');
  });

  it('refuses a monster with no regen time of its own', () => {
    const plain = { ...GRAVEDIGGER, regenHours: undefined };
    expect(typeof planMobFind(parts(['b', 'c'], plain), 'gravedigger')).toBe('string');
    expect(typeof planMobFind(parts(['b', 'c'], { ...GRAVEDIGGER, regenHours: 0 }), 'x')).toBe(
      'string'
    );
  });

  it('refuses one lair, naming the room, and none', () => {
    const one = planMobFind(parts(['c']), 'gravedigger');
    expect(typeof one).toBe('string');
    expect(one).toContain('the c');
    expect(typeof planMobFind(parts([]), 'gravedigger')).toBe('string');
  });

  it('refuses more lairs than a find walks, an unplaced character, and no way to any', () => {
    const many = Array.from({ length: tuning().mobFind.maxRooms + 1 }, (_, at) => `r${at}`);
    expect(typeof planMobFind(parts(many), 'gravedigger')).toBe('string');
    expect(typeof planMobFind(parts(['b', 'c'], GRAVEDIGGER, null), 'gravedigger')).toBe('string');
    expect(typeof planMobFind(parts(['e', 'f']), 'gravedigger')).toBe('string');
  });
});
