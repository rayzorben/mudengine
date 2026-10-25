import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { GateNames } from '../stepGates';
import { readLines } from '../textblock';
import { parseRoomScript } from '../../roomScript';
import { spellWaysOf, type LandingSpell } from '../scriptLandings';
import { WorldGraph } from '../../WorldGraph';

/*
 * Verbatim rows from `mdb/pmud.zip`: `Rooms.CMD`, `TBInfo` and the spells
 * they cast. The loot lines of the graveyard's tables are cut to a few, the
 * thresholds kept.
 */
const BLOCKS: Record<number, string> = {
  9121:
    '2:takeitem 1415:message 2703\n30:random 9122\n50:random 9123\n70:random 9125\n' +
    '90:random 9126\n93:message 1431\n100:minlevel 10 1431:cast 5078',
  9122: '80:message 1431\n81:message 1434:giveitem 64\n99:summon 11\n100:random 9126',
  9123: '80:message 1431\n92:summon 12:summon 11\n100:random 9126',
  9125: '80:message 1431\n89:summon 12\n100:random 9126',
  9126: '9:message 1434:giveitem 116\n70:summon 12:summon 12:summon 11:adddelay 4\n100:random 9126',
  9863: '99:cast 5415:cast 5462\n100:cast 5415:cast 5462',
  4989: ''
};

const SPELLS: Record<number, LandingSpell> = {
  // musty teleport: a room, no map, so the caster's.
  5078: {
    abilities: [
      [140, 9462],
      [144, 0]
    ]
  },
  // board ship: a room drawn from 715–723 on map 14.
  5415: {
    abilities: [
      [140, 0],
      [141, 14],
      [144, 0]
    ],
    power: [715, 723]
  },
  5462: {
    abilities: [
      [29, 1],
      [144, 0],
      [151, 5463]
    ],
    duration: 50
  },
  5463: {
    abilities: [
      [29, 1],
      [144, 0],
      [151, 5464]
    ],
    duration: 30
  },
  5464: {
    abilities: [
      [29, 1],
      [144, 0],
      [151, 5465]
    ],
    duration: 20
  },
  5465: {
    abilities: [
      [140, 1812],
      [141, 14],
      [151, 5466],
      [144, 0]
    ]
  },
  5466: {
    abilities: [
      [18, 0],
      [144, 0]
    ]
  }
};

const blocks = new Map(
  Object.entries(BLOCKS).map(([id, action]) => [
    Number(id),
    { lines: readLines(action), linkTo: null }
  ])
);

const realm = (here: `${number}/${number}`) => ({
  here,
  blocks,
  spell: (id: number) => SPELLS[id]
});

const nobody = (): undefined => undefined;
const named: GateNames = {
  item: nobody,
  spell: nobody,
  klass: nobody,
  race: nobody,
  ability: nobody,
  monster: nobody
};

describe('scriptLandings', () => {
  it('lands a dig on 7% of tries, behind the roll line’s level, and breaks the shovel on 2%', () => {
    const [dig] = parseRoomScript(
      'dig grave:checkitem 1415 1114:message 2673:adddelay 4:random 9121',
      named,
      realm('1/817')
    );
    expect(dig?.to).toBeUndefined();
    expect(dig?.gates).toEqual([{ kind: 'carry', item: 1415 }]);
    expect(dig?.landings).toEqual([
      { to: '1/9462', chance: 0.07, gates: [{ kind: 'level', min: 10 }] }
    ]);
    expect(dig?.breaks).toEqual([{ item: 1415, chance: 0.02 }]);
  });

  it('lands the passage on the beach, waiting in the crew quarters through three spells', () => {
    const [passage] = parseRoomScript(
      'secure passage to terra fuego:minlevel 50 3887:price 2000000 3890:random 9863:text 4989',
      named,
      realm('14/759')
    );
    expect(passage?.gates).toEqual([
      { kind: 'copper', copper: 2000000 },
      { kind: 'level', min: 50 }
    ]);
    const quarters = Array.from({ length: 9 }, (_, index) => `14/${715 + index}`);
    expect(passage?.landings).toEqual([
      { to: '14/1812', chance: 1, waits: { in: quarters, ticks: 100 } }
    ]);
  });

  it('keeps a cast that draws its room from its own roll as a draw, planned to and not through', () => {
    const [board] = parseRoomScript('board:cast 5415', named, realm('14/759'));
    expect(board?.landings).toBeUndefined();
    expect(board?.draws).toEqual([
      { landing: { spell: 5415, name: '', map: 14, low: 715, high: 723 }, chance: 1 }
    ]);
  });

  it('reads the Quicksylver carriage as five landings that add to every try', () => {
    const carriage = new Map([
      ...blocks,
      [
        4992,
        {
          lines: readLines(
            '1:teleport 61 2\n7:teleport 63 2\n12:teleport 150 2\n15:teleport 69 2\n100:teleport 2519 2'
          ),
          linkTo: null
        }
      ]
    ]);
    const [ride] = parseRoomScript('buy passage to silvermere:price 4500 1:random 4992', named, {
      ...realm('15/845'),
      blocks: carriage
    });
    expect(ride?.landings?.map((landing) => [landing.to, landing.chance])).toEqual([
      ['2/61', 0.01],
      ['2/63', 0.06],
      ['2/150', 0.05],
      ['2/69', 0.03],
      ['2/2519', 0.85]
    ]);
  });

  it('reads a room spell that moves whoever stands there as its ways, the slow ones and the room itself left out', () => {
    const lake = new Map([
      ...blocks,
      [
        9445,
        {
          lines: readLines('10:teleport 2280 17\n20:teleport 1203 17\n100:message 1'),
          linkTo: null
        }
      ],
      [9446, { lines: readLines('maxlevel 49:checkitem 690:random 9445'), linkTo: null }],
      [9447, { lines: readLines('random 9448'), linkTo: null }],
      [9448, { lines: readLines('1:teleport 1072 17\n100:message 1'), linkTo: null }]
    ]);
    const spells: Record<number, LandingSpell> = {
      ...SPELLS,
      9000: { abilities: [[148, 9446]] },
      9001: { abilities: [[148, 9447]] }
    };
    const at = { here: '17/1203' as const, blocks: lake, spell: (id: number) => spells[id] };
    expect(spellWaysOf(9000, at, named, 100)).toEqual({
      landings: [
        {
          to: '17/2280',
          chance: 0.1,
          gates: [
            { kind: 'carry', item: 690 },
            { kind: 'level', max: 49 }
          ]
        }
      ]
    });
    // One tick in a hundred is a hazard nobody waits for.
    expect(spellWaysOf(9001, at, named, 99)).toBeNull();
    // Positive control: the same spell at the bound is a way.
    expect(spellWaysOf(9001, at, named, 100)?.landings?.[0]?.to).toBe('17/1072');
  });

  it('keeps a certain landing as `to`', () => {
    const [go] = parseRoomScript('go portal:teleport 1041 8', named, realm('1/1'));
    expect(go?.to).toBe('8/1041');
    expect(go?.landings).toBeUndefined();
  });
});

const shipped = path.resolve('resources/world/paradigm.jsonl.gz');
const graph = fs.existsSync(shipped) ? WorldGraph.load(shipped) : null;

describe.skipIf(graph === null)(
  'ways that need a shovel, a fare or luck, on the shipped realm',
  () => {
    // Mutant: the dig's roll not followed, so Musty Grottos has no way in.
    it('digs into Musty Grottos with a shovel, about fourteen tries, and names the shovel without one', () => {
      const shovel = graph!.itemIdNamed('shovel')!;
      const dug = graph!.route('1/834', '1/9462', { level: 20, packKnown: true, keys: [shovel] });
      expect(dug.blocked).toBe(false);
      expect(dug.steps[0]?.command).toBe('dig grave');
      expect(dug.steps[0]?.requirement?.tries).toBeCloseTo(1 / 0.07, 1);
      const without = graph!.route('1/834', '1/9462', { level: 20, packKnown: true, keys: [] });
      expect(without.blocked).toBe(true);
      expect(without.blocks).toEqual([
        expect.objectContaining({ kind: 'carry', itemName: 'shovel' })
      ]);
    });

    // Mutant: a roll, an EndCast chain or an ask left unread, so the place has no way in.
    it('has a way into every place a roll, a passage or an ask reaches', () => {
      // Musty Grottos, the three island landings, Blackstone Cavern (an ask), the Void Apex.
      for (const room of ['1/9462', '14/1812', '14/1813', '14/15000', '17/3231', '16/12440']) {
        expect(graph!.hasWayIn(room as `${number}/${number}`), room).toBe(true);
      }
      // Positive control: a room nothing in the realm leads into still has none.
      expect(graph!.hasWayIn('1/62')).toBe(false);
    });

    // Mutant: a room's own spell read as a hazard only, so the class passages have no way in.
    it('waits in the Grand Chamber for its spell to move a Warrior with the training key', () => {
      const key = graph!.itemIdNamed('training key')!;
      const warrior = { level: 20, packKnown: true, classId: 1 };
      const keyed = graph!.route('17/3247', '17/3250', { ...warrior, keys: [key] });
      expect(keyed.blocked).toBe(false);
      expect(keyed.steps).toHaveLength(1);
      expect(keyed.steps[0]).toMatchObject({
        command: '',
        requirement: { kind: 'room-spell', waits: { in: ['17/3247'], ticks: 1 } }
      });
      // Without the key the way is walled, naming it.
      const none = graph!.route('17/3247', '17/3250', { ...warrior, keys: [] });
      expect(none.blocks).toEqual([expect.objectContaining({ kind: 'carry' })]);
      // And the Crimson Passage is not a Mystic's (class 5), whatever it carries.
      const mystic = graph!.route('17/3247', '17/3250', { ...warrior, classId: 5, keys: [key] });
      expect(mystic.blocked).toBe(true);
    });

    // Mutant: the river's sweep kept as a way, 143 ticks a try.
    it('opens no way out of a river room whose sweep is a hazard', () => {
      expect(graph!.byId('17/1072')).toBeDefined();
      const river = [...graph!.everyRoom()].filter(
        (room) => room.name === 'Silver River' && room.spellWays !== undefined
      );
      expect(river).toEqual([]);
    });

    // Mutant: the fare ceiling not judged, so an errand pays 2 runic on a 10 runic purse.
    it('sails to Terra Fuego, and walls the fare past the most a fare may be', () => {
      const sailor = { level: 55, packKnown: true, keys: [], wealth: 30_000_000 };
      const sailed = graph!.route('14/759', '14/1812', sailor);
      expect(sailed.blocked).toBe(false);
      expect(sailed.steps[0]?.requirement?.waits?.ticks).toBe(100);
      const capped = graph!.route('14/759', '14/1812', { ...sailor, fareCeiling: 1_000_000 });
      expect(capped.blocked).toBe(true);
      expect(capped.blocks).toEqual([
        expect.objectContaining({ kind: 'toll', tollCopper: 2_000_000, ceilingCopper: 1_000_000 })
      ]);
    });
  }
);
