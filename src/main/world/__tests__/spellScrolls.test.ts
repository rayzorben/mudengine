import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { WorldItem, WorldSpell } from '../../../shared/world';
import { learnerOf, learning } from '../learning';
import { spellScrolls, type ScrollRealm } from '../spellScrolls';
import { WorldGraph } from '../WorldGraph';

/*
 * The scrolls a planner may buy and `read` (todo 20): sold somewhere, teaching
 * a spell the book lacks, and not refused by the server's own check.
 */
const MISSILE: WorldSpell = {
  id: 1,
  name: 'magic missile',
  short: 'mmis',
  level: 1,
  mana: 3,
  mageryType: 1,
  mageryLevel: 1
};
const HEALING: WorldSpell = {
  id: 13,
  name: 'minor healing',
  short: 'mihe',
  level: 1,
  mana: 2,
  mageryType: 2
};
const SPELLS = new Map([MISSILE, HEALING].map((spell) => [spell.id, spell]));
const scroll = (id: number, name: string, spell: number): WorldItem =>
  ({ id, name, abilities: [[42, spell]] }) as WorldItem;
const ITEMS = [
  scroll(119, 'scroll of magic missile', 1),
  scroll(131, 'scroll of minor healing', 13)
];

const realm: ScrollRealm = {
  itemsWhere: (test) => ITEMS.filter(test),
  spellById: (id) => SPELLS.get(id) ?? null,
  stockingPlaces: (items) =>
    items.map((item) => ({
      item,
      map: 1,
      room: 10,
      roomName: 'Newhaven, Spell Shop',
      shop: 'Spell Shop',
      markup: 100,
      detour: 4,
      moves: 4
    })),
  priceAt: () => 0
};

const mage: CharacterState = {
  ...EMPTY_CHARACTER,
  className: 'Mage',
  progress: { ...EMPTY_CHARACTER.progress, level: 1 },
  spellbook: []
};

describe('the scrolls a character may learn from', () => {
  it('offers what the class may learn, at the counter that sells it', () => {
    const scrolls = spellScrolls(
      mage,
      learnerOf(mage, { id: 12, name: 'Mage', magery: 3, mageryType: 1 }),
      realm
    );
    expect(scrolls.map((each) => [each.name, each.verdict.kind, each.sold.copper])).toEqual([
      ['scroll of magic missile', 'learns', 0]
    ]);
  });

  it('offers nothing the book already lists', () => {
    const known = {
      ...mage,
      spellbook: [{ name: 'magic missile', short: 'mmis', level: 1, cost: 3 }]
    };
    expect(
      spellScrolls(
        known,
        learnerOf(known, { id: 12, name: 'Mage', magery: 3, mageryType: 1 }),
        realm
      )
    ).toEqual([]);
  });

  it('keeps an unknown verdict where the class row is not found', () => {
    const scrolls = spellScrolls(mage, learnerOf(mage, null), realm);
    expect(scrolls.map((each) => each.verdict.kind)).toEqual(['unknown', 'unknown']);
  });
});

describe('the book as it would be', () => {
  it('adds the rows, and says which went in', () => {
    const learnt = learning(mage, [1, 1, 999], realm);
    expect(learnt.learned).toEqual(['magic missile']);
    expect(learnt.state.spellbook).toEqual([
      { name: 'magic missile', short: 'mmis', level: 1, cost: 3 }
    ]);
    expect(mage.spellbook).toEqual([]);
  });
});

const PARADIGM = path.resolve(__dirname, '../../../../resources/world/paradigm.jsonl.gz');

/** The codes on the shipped world (format 55). */
describe.runIf(fs.existsSync(PARADIGM))('who may learn what, on the shipped world', () => {
  const graph = WorldGraph.load(PARADIGM);

  it('gives the Mage magic missile and the Warrior neither scroll', () => {
    const missile = graph.spellById(1)!;
    expect([missile.mageryType, missile.mageryLevel]).toEqual([1, 1]);
    const warrior = learnerOf({ ...mage, className: 'Warrior' }, graph.classNamed('Warrior'));
    const wizard = learnerOf(mage, graph.classNamed('Mage'));
    expect(warrior).toMatchObject({ mageryType: 0, mageryLevel: 0 });
    expect(wizard).toMatchObject({ mageryType: 1, mageryLevel: 3 });
  });
});
