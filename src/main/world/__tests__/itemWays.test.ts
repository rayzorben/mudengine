import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { NavigationOracle } from '../../../shared/navigation';
import { ItemWays, type UsedItem } from '../itemWays';
import { plan } from '../navigation/plan';
import { planRealmOf } from '../navigation/realm';
import type { GateNames } from '../navigation/stepGates';
import type { LandingSpell } from '../navigation/scriptLandings';
import { readLines } from '../navigation/textblock';
import { WorldGraph } from '../WorldGraph';

/*
 * Verbatim rows from `mdb/pmud.zip` (gmud.zip holds the same): the obsidian
 * talisman (item 948) casts 546, whose block wants the obelisk (item 802)
 * lying in the room and rolls 1092.
 */
const BLOCKS: Record<number, string> = {
  1091: 'message 1622:roomitem 802 1624:random 1092',
  1092: '10:takeitem 948 66:cast 547\n35:message 1624\n100:message 1217:cast 434:message 1625',
  // The potion of levitation: a stated teleport, which stays `WorldItem.lands`.
  1421: 'roomitem 993 1834:message 1835:teleport 1009 9:message 1836'
};

const SPELLS: Record<number, LandingSpell> = {
  546: { abilities: [[148, 1091]], power: [1091, 1091], name: 'obsidian talisman' },
  // obsidian talisman teleport: a room drawn from 2417–2430 on map 1.
  434: {
    abilities: [
      [140, 0],
      [141, 1],
      [151, 580]
    ],
    power: [2417, 2430],
    name: 'obsidian talisman teleport'
  },
  547: { abilities: [[1, 0]], power: [50, 250], name: 'obsidian talisman explosion' },
  580: { abilities: [[1, 0]], power: [25, 50], name: 'obsidian talisman drain' },
  607: { abilities: [[148, 1421]] }
};

const blocks = new Map(
  Object.entries(BLOCKS).map(([id, action]) => [
    Number(id),
    { lines: readLines(action), linkTo: null }
  ])
);

const nobody = (): undefined => undefined;
const named: GateNames = {
  item: nobody,
  spell: nobody,
  klass: nobody,
  race: nobody,
  ability: nobody,
  monster: nobody
};

const talisman: UsedItem = { id: 948, name: 'obsidian talisman', spells: [546] };
const potion: UsedItem = { id: 607, name: 'potion of levitation', spells: [607] };
const holding = new Map([
  [802, ['6/1889', '1/2417']],
  [993, ['3/1']]
]);

const ways = (landed: (item: number) => boolean = () => false): ItemWays =>
  new ItemWays([talisman, potion], holding, { blocks, spell: (id) => SPELLS[id] }, named, landed);

describe('item ways', () => {
  // Mutant: `landingsOfItems` alone, so the talisman's draw is no way.
  it('reads the talisman at an obelisk as a draw on 65% of uses that breaks it on 10%', () => {
    expect(ways().in('6/1889')).toEqual([
      {
        say: ['use obsidian talisman'],
        draws: [
          {
            landing: {
              spell: 434,
              name: 'obsidian talisman teleport',
              map: 1,
              low: 2417,
              high: 2430
            },
            chance: 0.65
          }
        ],
        breaks: [{ item: 948, chance: 0.1 }],
        gates: [{ kind: 'carry', item: 948 }]
      }
    ]);
  });

  // Mutant: the floor gate not read, so the talisman is a command of every room.
  it('opens nothing where no obelisk stands', () => {
    expect(ways().in('1/1')).toEqual([]);
    // Positive control: the same reader in an obelisk room has the way.
    expect(ways().in('1/2417')).toHaveLength(1);
  });

  // Mutant: a stated landing read twice, as `lands` and as a command.
  it('leaves an item with a stated landing to `lands`', () => {
    expect(ways((item) => item === potion.id).in('3/1')).toEqual([]);
    // Positive control: unlanded, the potion's teleport is the waterfall's command.
    expect(ways().in('3/1')[0]).toMatchObject({ say: ['use potion of levitation'], to: '9/1009' });
  });
});

const shipped = path.resolve('resources/world/paradigm.jsonl.gz');
const graph = fs.existsSync(shipped) ? WorldGraph.load(shipped) : null;

describe.skipIf(graph === null)('the obsidian talisman on the shipped realm', () => {
  // Mutant: no item ways at conversion, so the labyrinth's obelisk room has no way in.
  it('has a way into the labyrinth obelisk room, and none into a pocket that leads only into itself', () => {
    expect(graph!.hasWayIn('1/2417')).toBe(true);
    // 1/1929 and its dead end 1/1930 lead into each other and nothing else leads in.
    const talismanId = graph!.itemIdNamed('obsidian talisman')!;
    const pocket = graph!.route('6/1889', '1/1930', {
      level: 30,
      packKnown: true,
      keys: [talismanId]
    });
    expect(pocket.blocks).toEqual([{ kind: 'unreachable' }]);
  });

  it('uses the talisman at the Cleared Plaza, and names it without one', () => {
    const talismanId = graph!.itemIdNamed('obsidian talisman')!;
    const keyed = graph!.route('6/1889', '1/2417', {
      level: 30,
      packKnown: true,
      keys: [talismanId]
    });
    expect(keyed.blocked).toBe(false);
    expect(keyed.steps[0]?.command).toBe('use obsidian talisman');
    // Mutant: a draw's door left out of the refusal, which then says no path joins.
    const none = graph!.route('6/1889', '1/2417', { level: 30, packKnown: true, keys: [] });
    expect(none.blocks).toEqual([
      expect.objectContaining({ kind: 'carry', itemId: talismanId, itemName: 'obsidian talisman' })
    ]);
  });

  it('plans the talisman from the huge obsidian golem before the obelisk', () => {
    const won: NavigationOracle = {
      fight: () => ({ kind: 'win', survives: 0.99 }),
      affords: () => true
    };
    const made = plan(planRealmOf(graph!), won, '1/834', '1/2417', {
      level: 40,
      packKnown: true,
      keys: []
    });
    expect(made.kind).toBe('plan');
    const kills =
      made.kind === 'plan'
        ? made.steps.flatMap((s) => (s.kind === 'kill' ? [s.item.name] : []))
        : [];
    expect(kills).toEqual(['obsidian talisman']);
  });
});
