import { describe, expect, it } from 'vitest';

import { planArea, type AreaPlanParts } from '../areaPlan';
import type { WayStopper } from '../../world/navigation/stoppers';
import type { FightOdds, RoomId } from '../../../shared/world';

/**
 * A corridor a - b - c - d off where the character stands, with e beside a;
 * moves counted over it, past any room the traveller walls, as the engine's
 * `withinSteps` does.
 */
const EXITS: Record<string, string[]> = {
  a: ['b', 'e'],
  b: ['a', 'c'],
  c: ['b', 'd'],
  d: ['c'],
  e: ['a']
};

function within(walled: ReadonlySet<RoomId>) {
  return (from: RoomId, most: number): ReadonlyMap<RoomId, number> => {
    const moves = new Map<RoomId, number>([[from, 0]]);
    let frontier = [from];
    for (let away = 1; away <= most && frontier.length > 0; away += 1) {
      frontier = frontier
        .flatMap((room) => EXITS[room] ?? [])
        .filter((room) => !moves.has(room) && !walled.has(room));
      for (const room of frontier) moves.set(room, away);
    }
    return moves;
  };
}

function parts(
  monsters: Record<string, string[]>,
  odds: Record<string, FightOdds>,
  stoppers: Record<string, WayStopper> = {}
): AreaPlanParts {
  return {
    here: () => 'a',
    errands: {
      tripReach: (walled = new Set()) => ({
        within: within(walled),
        leg: () => 'unused',
        odds: { fight: (name) => odds[name] ?? { kind: 'win', survives: 1 }, affords: () => null }
      }),
      monstersIn: (room) => monsters[room] ?? []
    },
    roomHazards: { stopperFor: (room) => stoppers[room] ?? null }
  };
}

/** The Silver River's spell, stopped by a log raft the pack lacks. */
const RIVER: WayStopper = {
  spell: 753,
  name: 'river damage',
  items: [{ id: 690, name: 'log raft' }]
};

describe('the rooms an area search walks', () => {
  it('walls a room whose fight is lost, and the room only reached through it', () => {
    const plan = planArea(
      parts({ c: ['lashworm'] }, { lashworm: { kind: 'lose', survives: 0.2 } }),
      3
    );
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.lose).toEqual(['c']);
    expect(plan.behind).toEqual(['d']);
    expect(plan.walled).toContain('c');
    expect([...plan.tour].sort()).toEqual(['a', 'b', 'e']);
  });

  it('walls the ring one step past the radius, so no walk leaves the rooms judged', () => {
    const plan = planArea(parts({}, {}), 2);
    if (typeof plan === 'string') throw new Error(plan);
    expect([...plan.tour].sort()).toEqual(['a', 'b', 'c', 'e']);
    expect(plan.walled).toEqual(['d']);
  });

  it('leaves out a room whose odds are not worked out yet', () => {
    const plan = planArea(
      parts({ e: ['small giant rat'] }, { 'small giant rat': { kind: 'unread' } }),
      3
    );
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.unread).toEqual(['e']);
    expect(plan.tour).not.toContain('e');
  });

  it('leaves out a room whose fight is a win nobody could weigh', () => {
    const plan = planArea(
      parts({ e: ['giant rat'] }, { 'giant rat': { kind: 'win', survives: null } }),
      3
    );
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.unread).toEqual(['e']);
  });

  it('walls a room whose spell hurts without an item the pack lacks, and lists it', () => {
    const plan = planArea(parts({}, {}, { c: RIVER }), 3);
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.hazard).toEqual([{ room: 'c', spell: 'river damage', items: ['log raft'] }]);
    expect(plan.walled).toContain('c');
    expect(plan.behind).toEqual(['d']);
    expect([...plan.tour].sort()).toEqual(['a', 'b', 'e']);
  });

  it('tours the same room once the pack stops its spell', () => {
    // `stopperFor` answers null for a carried raft: the positive control.
    const plan = planArea(parts({}, {}, {}), 3);
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.hazard).toEqual([]);
    expect(plan.tour).toContain('c');
  });

  it('searches the room the character stands in whatever lives there', () => {
    const plan = planArea(
      parts({ a: ['lashworm'] }, { lashworm: { kind: 'lose', survives: 0.2 } }),
      1
    );
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.tour[0]).toBe('a');
    expect(plan.lose).toEqual([]);
  });
});
