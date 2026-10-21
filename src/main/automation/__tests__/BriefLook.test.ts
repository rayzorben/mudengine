import { beforeEach, describe, expect, it } from 'vitest';

import { BriefLook, ROOM_LOOK_KEY } from '../BriefLook';
import type { Intent, Offered } from '../CommandQueue';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';

/* Todo 20261020-2015-01: `l` once in a room shown without its description, for its picture. */
describe('looking at a room shown without its description', () => {
  let offered: Intent[];
  let wanted: boolean;
  let idle: boolean;
  let shippedRooms: Set<string>;
  let answer: Offered;
  let look: BriefLook;

  const at = (map: number, number: number, description: string | null = null): CharacterState => ({
    ...structuredClone(EMPTY_CHARACTER),
    phase: 'in-game',
    room: { ...EMPTY_CHARACTER.room, map, number, name: 'Oak Street', description, ambiguous: 0 }
  });

  beforeEach(() => {
    offered = [];
    wanted = true;
    idle = true;
    shippedRooms = new Set();
    answer = 'queued';
    look = new BriefLook(
      {
        offer: (intent) => {
          offered.push(intent);
          return answer;
        }
      },
      {
        wanted: () => wanted,
        shipped: (_realm, map, number) => shippedRooms.has(`${map}/${number}`)
      },
      () => idle
    );
  });

  it('offers l once per room in the probe band, and again after leaving the realm', () => {
    look.onCharacter(at(1, 78));
    look.onCharacter(at(1, 78));
    expect(offered.map((intent) => [intent.command, intent.priority, intent.coalesceKey])).toEqual([
      ['l', 'probe', ROOM_LOOK_KEY]
    ]);
    look.onCharacter(at(1, 79));
    expect(offered).toHaveLength(2);
    look.left();
    look.onCharacter(at(1, 78));
    expect(offered).toHaveLength(3);
  });

  it('looks at nothing the set has a picture of, nothing described, and nothing uncertain', () => {
    shippedRooms.add('1/78');
    look.onCharacter(at(1, 78));
    look.onCharacter(at(1, 79, 'A quiet street.'));
    look.onCharacter({ ...at(1, 80), room: { ...at(1, 80).room, ambiguous: 2 } });
    look.onCharacter({ ...at(1, 81), room: { ...at(1, 81).room, name: null } });
    expect(offered).toEqual([]);
  });

  it('waits for the character to stand still, then looks once', () => {
    idle = false;
    look.onCharacter(at(1, 78));
    expect(offered).toEqual([]);
    idle = true;
    look.onCharacter(at(1, 78));
    expect(offered).toHaveLength(1);
  });

  it('looks at nothing in a fight, with the switch off, or when the queue took nothing', () => {
    look.onCharacter({ ...at(1, 78), inCombat: true });
    expect(offered).toEqual([]);
    wanted = false;
    look.onCharacter(at(1, 78));
    expect(offered).toEqual([]);
    wanted = true;
    answer = 'offline';
    look.onCharacter(at(1, 78));
    answer = 'queued';
    look.onCharacter(at(1, 78));
    expect(offered).toHaveLength(2);
  });
});
