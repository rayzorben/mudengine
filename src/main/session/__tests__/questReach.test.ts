import { describe, expect, it } from 'vitest';

import { QuestReach, reachAll, reachLegs, stepRooms, type ReachRouter } from '../questReach';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { Quest, QuestStep } from '../../../shared/quests';
import type { Route, RoomId } from '../../../shared/world';

const step = (part: Partial<QuestStep>): QuestStep => ({
  block: 1,
  say: [],
  needs: [],
  takes: [],
  gives: [],
  ...part
});

/**
 * A realm of level walls: each room opens at the level named, and a second
 * wall may stand behind the first, as MerchantCaptain's crate lies past a 40
 * and a 60 on the ways a level 13 character tries first.
 */
function walls(open: Record<string, number[]>): ReachRouter & { asked: number } {
  const router = {
    asked: 0,
    legAs(_from: RoomId, to: RoomId, traveller: { level?: number | null }): Route {
      router.asked += 1;
      const next = (open[to] ?? []).find((level) => level > (traveller.level ?? 0));
      if (next === undefined) return { steps: [], cost: 1, blocked: false };
      return {
        steps: [],
        cost: 0,
        blocked: true,
        blocks: [
          { kind: 'level', at: '1/1', to, name: to, level: traveller.level ?? null, minLevel: next }
        ]
      } as Route;
    }
  };
  return router;
}

const run = (router: ReachRouter, quest: Quest, level: number) =>
  reachAll(
    router,
    reachLegs(
      quest,
      quest.steps.map((each) => ({ rank: each.to ?? 0, acts: [each] }))
    ),
    '1/1' as RoomId,
    { level },
    3,
    () => false
  );

describe('the level the way to a quest step opens at', () => {
  // DaoLordQuest rank 11: the Dao Lord's plane is a portal gated on level 20.
  const dao: Quest = {
    id: 134,
    name: 'DaoLordQuest',
    steps: [step({ block: 2688, from: 10, to: 11, kill: 'Dao Lord', room: '12/2251' })]
  };

  it('says the portal’s level for a level 13 character', async () => {
    expect(await run(walls({ '12/2251': [20] }), dao, 13)).toEqual({
      134: { rank: 11, level: 20 }
    });
  });

  it('says nothing once the character is past it', async () => {
    expect(await run(walls({ '12/2251': [20] }), dao, 20)).toEqual({});
  });

  it('climbs a second wall behind the first, and stops at the tries', async () => {
    const crate: Quest = {
      id: 211,
      name: 'MerchantCaptain',
      steps: [
        step({
          block: 5455,
          from: 1,
          to: 2,
          takes: [{ id: 3730 }],
          sources: [{ id: 3730, from: [{ k: 'said', room: '14/6256' } as never] }]
        })
      ]
    };
    expect(await run(walls({ '14/6256': [40, 60] }), crate, 13)).toEqual({
      211: { rank: 2, level: 60 }
    });
    const router = walls({ '14/6256': [40, 60, 70, 80] });
    expect(await run(router, crate, 13)).toEqual({ 211: { rank: 2, level: 70 } });
    expect(router.asked).toBe(3);
  });

  it('never waits on a rank one of whose alternatives it could not route', async () => {
    const two: Quest = {
      id: 9,
      name: 'Two',
      steps: [step({ block: 1, to: 1, room: '2/2' }), step({ block: 2, to: 1, who: 'nobody' })]
    };
    const legs = reachLegs(two, [{ rank: 1, acts: two.steps }]);
    expect(
      await reachAll(walls({ '2/2': [50] }), legs, '1/1' as RoomId, { level: 1 }, 3, () => false)
    ).toEqual({});
  });

  it('answers nothing for an ask a later one replaced', async () => {
    const legs = reachLegs(dao, [{ rank: 11, acts: dao.steps }]);
    expect(
      await reachAll(walls({}), legs, '1/1' as RoomId, { level: 1 }, 3, () => true)
    ).toBeNull();
  });
});

describe('the rooms a step wants', () => {
  it('takes the step’s room and where a script hands over what it takes', () => {
    const found = stepRooms(
      step({
        room: '14/310',
        takes: [{ id: 3731 }],
        sources: [
          { id: 3731, from: [{ k: 'asked', room: '14/759' } as never] },
          { id: 999, from: [{ k: 'asked', room: '1/1' } as never] }
        ]
      })
    );
    expect(found).toEqual(['14/310', '14/759']);
  });
});

describe('the quest book’s ask', () => {
  const dao: Quest = {
    id: 134,
    name: 'DaoLordQuest',
    steps: [step({ block: 2688, to: 1, kill: 'Dao Lord', room: '12/2251' })]
  };
  const at = (room: { map: number | null; number: number | null }): CharacterState => ({
    ...EMPTY_CHARACTER,
    room: { ...EMPTY_CHARACTER.room, ...room },
    progress: { ...EMPTY_CHARACTER.progress, level: 13 }
  });
  const realm = { quests: () => [dao] };
  const reach = (state: CharacterState, world = true) =>
    new QuestReach({
      world: () => (world ? realm : undefined),
      router: walls({ '12/2251': [20] }),
      state: () => state,
      watched: () => ({}),
      traveller: (now) => ({ level: now.progress.level })
    });

  it('answers the portal’s level from where the character stands', async () => {
    expect(await reach(at({ map: 12, number: 2250 })).ask({})).toEqual({
      134: { rank: 1, level: 20 }
    });
  });

  it('answers unknown with no realm or nowhere placed', async () => {
    expect(await reach(at({ map: 12, number: 2250 }), false).ask({})).toBeNull();
    expect(await reach(at({ map: null, number: null })).ask({})).toBeNull();
  });

  it('answers a superseded ask with the later one’s walls, never with none', async () => {
    const one = reach(at({ map: 12, number: 2250 }));
    const first = one.ask({});
    const second = one.ask({});
    // Positive control: the later ask lands with the wall.
    expect(await second).toEqual({ 134: { rank: 1, level: 20 } });
    expect(await first).toEqual({ 134: { rank: 1, level: 20 } });
  });

  it('stops a run whose realm is put down under it', async () => {
    let held: { quests(): Quest[] } | undefined = realm;
    const asked: string[] = [];
    const gone = new QuestReach({
      world: () => held,
      router: {
        legAs: (_from, to) => {
          asked.push(to);
          return null;
        }
      },
      state: () => at({ map: 12, number: 2250 }),
      watched: () => ({}),
      traveller: (now) => ({ level: now.progress.level })
    });
    // Positive control: the same ask routes the portal while the realm stands.
    expect(await gone.ask({})).toEqual({});
    expect(asked).toEqual(['12/2251']);
    const running = gone.ask({});
    held = undefined;
    expect(await running).toBeNull();
    expect(asked).toEqual(['12/2251']);
  });
});
