import { describe, expect, it } from 'vitest';

import { openingsIn, withOpenings } from '../questOpenings';
import type { Quest } from '../../../shared/quests';
import type { RoomCommand } from '../../../shared/world';

const captainAt = (atLeast: number) => ({ kind: 'ability' as const, id: 211, atLeast });

// Blackwater Harbor, Wharf (14/759) on pmud.zip, as `parseRoomScript` reads it.
const wharf: RoomCommand[] = [
  {
    say: ['secure passage to albion'],
    gates: [
      { kind: 'copper', copper: 2_000_000 },
      { kind: 'level', min: 50 }
    ]
  },
  {
    say: ['secure passage to talkiran'],
    gates: [{ kind: 'copper', copper: 6_000_000 }, captainAt(3), { kind: 'level', min: 65 }]
  }
];

describe('the ways a quest counter lets through', () => {
  it('reads a room command gated on a counter, with its own level', () => {
    expect(openingsIn({ here: '14/759', commands: wharf, exits: {} })).toEqual([
      {
        counter: 211,
        opening: {
          kind: 'command',
          say: ['secure passage to talkiran'],
          room: '14/759',
          atLeast: 3,
          minLevel: 65
        }
      }
    ]);
  });

  it('reads an exit through the exit table’s own gates', () => {
    const found = openingsIn({
      here: '12/1173',
      commands: [],
      exits: {
        e: { m: 12, r: 1174, i: 'Ability: 134 w/value 2 to 999' },
        w: { m: 12, r: 1172 }
      }
    });
    expect(found).toEqual([
      {
        counter: 134,
        opening: {
          kind: 'exit',
          direction: 'e',
          room: '12/1173',
          to: '12/1174',
          atLeast: 2,
          atMost: 999
        }
      }
    ]);
  });

  it('leaves out a gate that wants the counter absent or below a rank', () => {
    const shuts: RoomCommand[] = [
      { say: ['revive portal'], gates: [{ kind: 'ability', id: 134, atMost: 9 }] },
      { say: ['go portal'], gates: [{ kind: 'ability', id: 133, absent: true }] }
    ];
    // Positive control: the wharf's passage is read from the same call.
    expect(openingsIn({ here: '1/1', commands: [...shuts, ...wharf], exits: {} })).toHaveLength(1);
  });

  const captain: Quest = {
    id: 211,
    name: 'MerchantCaptain',
    steps: [
      { block: 5455, say: ['return'], needs: [], takes: [{ id: 3730 }], gives: [], from: 1, to: 2 },
      { block: 5458, say: ['map'], room: '14/310', needs: [], takes: [], gives: [], from: 2, to: 3 }
    ]
  };

  it('tells each quest its ways, less its own steps and a command that gives an item a step takes back', () => {
    const found = [
      ...openingsIn({ here: '14/759', commands: wharf, exits: {} }),
      // `pull crate` hands over the crate rank 2 takes back.
      ...openingsIn({
        here: '14/6256',
        commands: [{ say: ['pull crate', 'take crate'], gates: [captainAt(1)] }],
        exits: {}
      }),
      // A step of the quest's own, which its counter also gates.
      ...openingsIn({
        here: '14/310',
        commands: [{ say: ['map'], gates: [captainAt(2)] }],
        exits: {}
      })
    ];
    const handovers = new Map([
      [3730, [{ k: 'room' as const, at: '14/6256', say: ['pull crate'] }]]
    ]);
    const [quest] = withOpenings([captain], [...found, ...found], handovers);
    expect(quest?.opens?.map((way) => way.room)).toEqual(['14/759']);
  });

  it('leaves out a way into a room one of the quest’s steps is in', () => {
    const found = openingsIn({
      here: '14/309',
      commands: [],
      exits: {
        n: { m: 14, r: 310, i: 'Ability: 211 w/value 2 to 999' },
        s: { m: 14, r: 308, i: 'Ability: 211 w/value 2 to 999' }
      }
    });
    // Positive control: both exits are read; only the one into 14/310 is the quest's own.
    expect(found).toHaveLength(2);
    const [quest] = withOpenings([captain], found, new Map());
    expect(quest?.opens?.map((way) => way.to)).toEqual(['14/308']);
  });

  it('leaves a quest no way reads as it was', () => {
    const [quest] = withOpenings([captain], [], new Map());
    expect(quest).toBe(captain);
  });
});
