import { describe, expect, it } from 'vitest';

import { GatedGrounds, openingLevels } from '../gatedGrounds';
import { EMPTY_CHARACTER } from '../../../shared/character';
import type { MobEntity } from '../../../shared/entities';
import type { WorldRoom } from '../../../shared/world';

/*
 * Todo 2322-01: Paradigm from 1/297 at level 45 sweeps open behind gates at
 * 50, 60, 75 and 85. A fake realm where room `rN` opens at level N.
 */
describe('the level a ground opens at', () => {
  const opensAt: Record<string, number> = { r50: 50, r60: 60, r75: 75, r85: 85 };
  const asked: number[] = [];
  const sweep = (level: number): ReadonlyMap<string, number> => {
    asked.push(level);
    return new Map(
      Object.entries(opensAt)
        .filter(([, at]) => level >= at)
        .map(([room]) => [room, 1])
    );
  };

  it('is the least level whose sweep reaches any of its rooms', () => {
    const found = openingLevels(
      new Map([
        ['dragon', ['r50']],
        ['lord', ['r85', 'r60']],
        ['golem', ['r75']]
      ]),
      45,
      sweep
    );
    expect(found).toEqual(
      new Map([
        ['dragon', 50],
        ['lord', 60],
        ['golem', 75]
      ])
    );
    // Shared sweeps, halving: far fewer than one per level.
    expect(new Set(asked).size).toBeLessThan(20);
  });

  it('is nothing for a ground no level opens', () => {
    expect(openingLevels(new Map([['vault', ['keyed']]]), 45, sweep)).toEqual(
      new Map([['vault', null]])
    );
  });
});

describe('the grounds behind a level gate', () => {
  const lair = (id: string, list: string): WorldRoom =>
    ({
      map: 1,
      room: Number(id.slice(1)),
      name: id,
      exits: [],
      lair: list
    }) as unknown as WorldRoom;
  const rooms: Record<string, WorldRoom> = {
    // One ground, `(Max 1): 1`, with a room open now and one behind the gate.
    r1: lair('r1', '(Max 1): 1'),
    r2: lair('r2', '(Max 1): 1'),
    r3: lair('r3', '(Max 2): 3'),
    r4: { ...lair('r4', ''), lair: undefined, npcId: 4 } as unknown as WorldRoom
  };
  const opens: Record<string, number> = { r1: 0, r2: 50, r3: 60, r4: 75 };
  const pays: Record<string, number> = { r3: 2000, r4: 5000 };
  const entity = (room: WorldRoom) =>
    [{ name: `mob of ${room.name}`, experience: pays[room.name] }] as unknown as MobEntity[];
  let sweeps = 0;
  let key = 'k';
  const world = {
    byId: (id: string) => rooms[id],
    lairEntities: entity,
    residentEntities: entity,
    buildMobEntity: () => undefined
  } as never;
  const gated = new GatedGrounds({
    world: () => world,
    navigation: {
      within: (_from: string, _steps: number, traveller: { level?: number | null }) => {
        sweeps += 1;
        const level = traveller.level ?? 0;
        return new Map(
          Object.entries(opens)
            .filter(([, at]) => level >= at)
            .map(([room, at]) => [room, at])
        );
      }
    } as never,
    errands: { travellerNow: () => ({ level: 45 }), reachKey: () => key } as never
  });
  const state = { ...EMPTY_CHARACTER, progress: { ...EMPTY_CHARACTER.progress, level: 45 } };
  const reach = new Map([['r1', 0]]);

  it('lists the grounds no room of which is reached, best paying first, with the level', () => {
    const found = gated.around(state, 'r1', Infinity, reach, 10);
    expect(found.map(({ mobs, level, roomCount }) => [mobs[0], level, roomCount])).toEqual([
      ['mob of r4', 75, 1],
      ['mob of r3', 60, 1]
    ]);
  });

  it('keeps the levels while what decides a way holds, and asks again when it moves', () => {
    sweeps = 0;
    gated.around(state, 'r1', Infinity, reach, 10);
    expect(sweeps).toBe(1);
    key = 'moved';
    sweeps = 0;
    gated.around(state, 'r1', Infinity, reach, 10);
    expect(sweeps).toBeGreaterThan(1);
  });

  it('lists nothing while the level is unread', () => {
    const unread = { ...state, progress: { ...state.progress, level: null } };
    expect(gated.around(unread, 'r1', Infinity, reach, 10)).toEqual([]);
  });
});
