import { describe, expect, it } from 'vitest';

import {
  hurtsUnstopped,
  stopperHeld,
  stoppersAlong,
  type StopperRealm
} from '../navigation/stoppers';
import type { SpellHazard } from '../../../shared/world';

/* The Silver River's spell on gmud: 15 a tick, stopped by four boats. */
const RIVER: SpellHazard = { damage: 15, avoidedBy: [690, 691, 1181, 3609] };
const NAMES: Record<number, string> = {
  690: 'log raft',
  691: 'wooden skiff',
  1181: 'silverbark canoe'
};

const realm: StopperRealm = {
  roomSpell: (room) =>
    room.startsWith('river')
      ? { id: 753, name: 'river damage', hazard: RIVER }
      : room === 'pool'
        ? { id: 711, name: 'drowning', hazard: { damage: 5 } }
        : null,
  itemName: (item) => NAMES[item]
};

describe('what a way wants carried against its rooms’ spells', () => {
  it('folds the rooms of one spell, names only the items the realm names, and skips a spell nothing stops', () => {
    const way = stoppersAlong(['dock', 'river1', 'river2', 'pool', 'river3'], realm);
    expect(way).toEqual([
      {
        spell: 753,
        name: 'river damage',
        items: [
          { id: 690, name: 'log raft' },
          { id: 691, name: 'wooden skiff' },
          { id: 1181, name: 'silverbark canoe' }
        ]
      }
    ]);
  });

  it('is held by any one of them, and never by an unlisted pack', () => {
    const [river] = stoppersAlong(['river1'], realm);
    expect(stopperHeld(river!, [1181])).toBe(true);
    expect(stopperHeld(river!, [5])).toBe(false);
    expect(stopperHeld(river!, null)).toBe(false);
  });

  it('hurts without a stopper or a stated ward, and not with one', () => {
    expect(hurtsUnstopped(RIVER, [], [])).toBe(true);
    expect(hurtsUnstopped(RIVER, null, [])).toBe(true);
    expect(hurtsUnstopped(RIVER, [690], [])).toBe(false);
    expect(hurtsUnstopped({ avoidedBySpell: [3], damage: 15 }, [], [3])).toBe(false);
    // Only a stated figure: a chain the reader could not follow keeps its price.
    expect(hurtsUnstopped({ unread: true, avoidedBy: [1180] }, [], [])).toBe(false);
    expect(hurtsUnstopped({ summons: true }, [], [])).toBe(false);
  });
});
