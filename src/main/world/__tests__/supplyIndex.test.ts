import { describe, expect, it } from 'vitest';

import { HAZARD_ABILITY } from '../../../shared/abilities';
import { indexSpells, rowProfile } from '../buildRealm';
import { readTextblocks } from '../navigation/textblock';
import type { RealmSource, RealmTable } from '../RealmSource';
import { indexSupply, itemsInSupply, type BuiltRun } from '../supplyIndex';

/** A realm database made of literals, as `buildRealm.test.ts` builds one. */
function fake(tables: Record<string, Record<string, unknown>[]>): RealmSource {
  return {
    path: '/tmp/test.mdb',
    kind: 'mdb',
    tableNames: () => Object.keys(tables),
    table: (name): RealmTable | null => {
      const found = Object.entries(tables).find(
        ([key]) => key.toLowerCase() === name.toLowerCase()
      );
      if (!found) return null;
      return { name: found[0], columns: Object.keys(found[1][0] ?? {}), rows: found[1] };
    },
    close: () => {}
  };
}

const blocks = (actions: Record<number, string>): Record<string, unknown>[] =>
  Object.entries(actions).map(([id, action]) => ({
    Number: Number(id),
    Action: action,
    LinkTo: 0
  }));

function supplyOf(tables: Record<string, Record<string, unknown>[]>) {
  const source = fake(tables);
  return indexSupply(source, readTextblocks(source), indexSpells(source), rowProfile);
}

const runOf = (runs: readonly BuiltRun[], k: BuiltRun['k']): BuiltRun | undefined =>
  runs.find((run) => run.k === k);

describe('indexSupply', () => {
  it('reads a shelf that restocks, and not a gang house shop', () => {
    const { sh } = supplyOf({
      Shops: [
        {
          Number: 1,
          Name: 'Weapons',
          ShopType: 10,
          'Item-0': 7,
          'Max-0': 30,
          'Time-0': 10,
          'Amount-0': 30,
          '%-0': 100
        },
        {
          Number: 2,
          Name: 'Gang',
          ShopType: 11,
          'Item-0': 8,
          'Max-0': 1,
          'Time-0': 10,
          'Amount-0': 1,
          '%-0': 100
        },
        {
          Number: 3,
          Name: 'Recycler',
          ShopType: 0,
          'Item-0': 9,
          'Max-0': 0,
          'Time-0': 0,
          'Amount-0': 0,
          '%-0': 0
        }
      ]
    });
    expect(sh).toEqual([[1, 7, 30, 100, 10]]);
  });

  it('reads drops, a stated clock and a roaming group', () => {
    const { runs, rt, ro } = supplyOf({
      Monsters: [
        {
          Number: 1,
          Name: 'orc',
          RegenTime: 17,
          'DropItem-0': 7,
          'DropItem%-0': 10,
          'Summoned By': 'Group: 1/2'
        },
        { Number: 2, Name: 'rat', RegenTime: 0, 'Summoned By': '[1]Group(lair): 1/3' }
      ]
    });
    expect(runOf(runs, 'drop')).toEqual({ k: 'drop', m: 1, gi: [[7, 0.1]] });
    expect(rt).toEqual([[1, 17]]);
    expect(ro).toEqual([1]);
  });

  it('follows a monster summoned on arrival, and one cast between rounds at its chance', () => {
    const { runs } = supplyOf({
      Spells: [{ Number: 60, Name: 'call', 'Abil-0': HAZARD_ABILITY.summon, 'AbilVal-0': 2 }],
      Monsters: [
        { Number: 1, Name: 'queen', CreateSpell: 60 },
        { Number: 3, Name: 'priestess', 'MidSpell-0': 60, 'MidSpell%-0': 20 }
      ]
    });
    expect(runOf(runs, 'arrive')).toEqual({ k: 'arrive', m: 1, sm: [[2, 1]] });
    expect(runOf(runs, 'fight')).toEqual({ k: 'fight', m: 3, p: 0.2, sm: [[2, 1]] });
  });

  it('takes one of a range of blocks where a used item’s spell names none', () => {
    const { runs } = supplyOf({
      Items: [{ Number: 99, Name: 'chest', 'Abil-0': HAZARD_ABILITY.castsSpell, 'AbilVal-0': 50 }],
      Spells: [
        {
          Number: 50,
          Name: 'open',
          'Abil-0': HAZARD_ABILITY.textBlock,
          'AbilVal-0': 0,
          MinBase: 20,
          MaxBase: 21
        }
      ],
      TBInfo: blocks({ 20: 'giveitem 7', 21: 'giveitem 8' })
    });
    expect(runOf(runs, 'use')).toEqual({
      k: 'use',
      it: 99,
      gi: [
        [7, 0.5],
        [8, 0.5]
      ]
    });
  });

  it('multiplies the rolls of a table, each rolled afresh', () => {
    // Three rolls of 5%: 0.15 copies on average (14.3% for at least one).
    const { runs } = supplyOf({
      Rooms: [{ 'Map Number': 1, 'Room Number': 2, CMD: 1 }],
      TBInfo: blocks({
        1: 'open chest:random 10:random 10:random 10',
        10: '5:giveitem 7\n100:message 1'
      })
    });
    expect(runOf(runs, 'say')).toEqual({
      k: 'say',
      at: ['1/2'],
      say: 'open chest',
      gi: [[7, 0.15]]
    });
  });

  it('keeps a phrase’s gate, and one run for every room sharing the block', () => {
    const { runs } = supplyOf({
      Rooms: [
        { 'Map Number': 1, 'Room Number': 2, CMD: 1 },
        { 'Map Number': 1, 'Room Number': 3, CMD: 1 }
      ],
      TBInfo: blocks({ 1: 'ring bell:takeitem 30:summon 2\npray:checkability 133 1:giveitem 9' })
    });
    expect(runs).toEqual([
      { k: 'say', at: ['1/2', '1/3'], say: 'ring bell', u: [30], sm: [[2, 1]] },
      { k: 'say', at: ['1/2', '1/3'], say: 'pray', q: 1, gi: [[9, 1]] }
    ]);
  });

  it('reads no roll table line as something to type', () => {
    const { runs } = supplyOf({
      Rooms: [{ 'Map Number': 1, 'Room Number': 2, CMD: 1 }],
      TBInfo: blocks({ 1: '50:giveitem 7\n100:giveitem 8' })
    });
    expect(runs).toEqual([]);
  });

  it('names every item it rates, so the item index carries them', () => {
    const supply = supplyOf({
      Items: [{ Number: 99, Name: 'chest', 'Abil-0': HAZARD_ABILITY.castsSpell, 'AbilVal-0': 50 }],
      Spells: [{ Number: 50, Name: 'open', 'Abil-0': HAZARD_ABILITY.textBlock, 'AbilVal-0': 20 }],
      TBInfo: blocks({ 20: 'giveitem 7' })
    });
    expect([...itemsInSupply(supply)].sort()).toEqual([7, 99]);
  });
});
