import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { UNKNOWN_WEARER, type Wearer } from '../../../shared/gear';
import type { ProwessSheet } from '../../../shared/prowess';
import { armourPerWeight } from '../../../shared/slotGear';
import type { WorldItem } from '../../../shared/world';
import { slotAskerOf, slotGear, type SlotAsker } from '../slotGear';
import { wearerOf } from '../wearer';
import { WorldGraph } from '../WorldGraph';

const SHEET: ProwessSheet = {
  level: 20,
  agility: 60,
  intellect: 50,
  charm: 50,
  willpower: 50,
  health: 60,
  strength: 60,
  spellcasting: 0,
  combatLevel: 4,
  mageryLevel: null,
  encumbrancePercent: 10
};

const WARRIOR: Wearer = { ...UNKNOWN_WEARER, classId: 1, level: 20, weaponType: 8, armourType: 9 };

function asker(over: Partial<SlotAsker> = {}): SlotAsker {
  return { wearer: WARRIOR, sheet: SHEET, family: 'greatermud', attack: 'a', ...over };
}

function realm(items: WorldItem[]): { itemsWornIn(worn: number): WorldItem[] } {
  return { itemsWornIn: (worn) => items.filter((item) => item.worn === worn) };
}

const helm = (id: number, name: string, ac: number, dr = 0, over: Partial<WorldItem> = {}) =>
  ({ id, name, worn: 2, kind: 'armour', armour: { ac, dr }, ...over }) as WorldItem;

const sword = (id: number, name: string, min: number, max: number, speed: number) =>
  ({ id, name, worn: 1, kind: 'weapon', weapon: { min, max, speed, kind: 2 } }) as WorldItem;

describe("a slot's gear, best first", () => {
  it('ranks armour by AC, then DR, and counts what it leaves out', () => {
    const gear = slotGear(
      2,
      realm([
        helm(1, 'leather cap', 2),
        helm(2, 'steel helm', 5, 1),
        helm(3, 'iron helm', 5, 3),
        helm(4, 'crown of ages', 9, 0, { minLevel: 50 })
      ]),
      asker()
    );
    expect(gear.slot).toBe('Head');
    expect(gear.ranking).toEqual({ by: 'armour' });
    expect(gear.rows.map((row) => row.name)).toEqual(['iron helm', 'steel helm', 'leather cap']);
    expect(gear.refused).toBe(1);
  });

  it('ranks weapons by damage a round, so a fast small blade can beat a slow big one', () => {
    const items = [sword(1, 'dagger', 3, 7, 900), sword(2, 'greatsword', 12, 20, 4000)];
    const gear = slotGear(1, realm(items), asker());
    expect(gear.ranking).toEqual({ by: 'weapon', method: 'attack', rounds: true });
    const [first, second] = gear.rows;
    expect(first!.perRound!.value).toBeGreaterThan(second!.perRound!.value);
  });

  it('ranks by the attack verb the character uses', () => {
    const gear = slotGear(1, realm([sword(1, 'dagger', 3, 7, 900)]), asker({ attack: 'smash' }));
    expect(gear.ranking).toEqual({ by: 'weapon', method: 'smash', rounds: true });
  });

  it("carries each row's weight, and a weapon's hands and blow", () => {
    const gear = slotGear(2, realm([helm(1, 'steel helm', 40, 10, { encumbrance: 200 })]), asker());
    expect(gear.rows[0]).toMatchObject({ weight: 200, weaponClass: null });
    const blade = slotGear(1, realm([sword(1, 'dagger', 3, 7, 900)]), asker()).rows[0];
    expect(blade).toMatchObject({ weight: 0, weaponClass: { hands: 1, damage: 'sharp' } });
  });

  it("reckons MMUD Explorer's AC/Enc: AC and DR for every 100 of weight", () => {
    expect(armourPerWeight({ ac: 40, dr: 10, weight: 200 })).toBe(25);
    // A weightless piece counts as weight 1, so it sorts first.
    expect(armourPerWeight({ ac: 5, dr: 0, weight: 0 })).toBe(500);
    expect(armourPerWeight({ ac: null, dr: null, weight: 30 })).toBeNull();
  });

  it('says a character with nothing read may be refused some of them', () => {
    expect(slotGear(2, realm([]), asker()).unread).toBe(true);
    const known = { ...WARRIOR, raceId: 1, alignment: 'Good' as const };
    expect(slotGear(2, realm([]), asker({ wearer: known })).unread).toBe(false);
  });

  it('still orders weapons by the mean blow where no round can be reckoned', () => {
    const items = [sword(1, 'dagger', 3, 7, 900), sword(2, 'greatsword', 12, 20, 4000)];
    const gear = slotGear(1, realm(items), asker({ family: 'majormud' }));
    expect(gear.rows.map((row) => row.name)).toEqual(['greatsword', 'dagger']);
    expect(gear.rows.every((row) => row.perRound === null)).toBe(true);
    expect(gear.ranking).toEqual({ by: 'weapon', method: 'attack', rounds: false });
  });
});

const PARADIGM = path.resolve(__dirname, '../../../../resources/world/paradigm.jsonl.gz');

/** Against the shipped world, which is where the class table's codes are. */
describe.runIf(fs.existsSync(PARADIGM))("a slot's gear on the shipped world", () => {
  const graph = WorldGraph.load(PARADIGM);
  const mage = graph.classNamed('Mage');

  it('carries what a class may wield and wear (format 48)', () => {
    expect(mage?.armourType).toBe(1);
    expect(mage?.weaponType).toBe(9);
  });

  it('lists no armour heavier than cloth for a Mage unless the item names Mages', () => {
    const wearer = wearerOf(
      {
        className: 'Mage',
        race: null,
        name: null,
        online: [],
        progress: { level: 30, strength: 40 } as never
      },
      graph
    );
    const gear = slotGear(11, graph, asker({ wearer }));
    expect(gear.rows.length).toBeGreaterThan(0);
    expect(gear.refused).toBeGreaterThan(0);
    for (const row of gear.rows) {
      const item = graph.item(row.id)!;
      const heavy = (item.armour?.kind ?? 0) > 1;
      expect(heavy && !(item.classes ?? []).includes(mage!.id)).toBe(false);
    }
  });
});

/*
 * A weapon's own `MaxDamage` and `Speed` rows count for that weapon only (todo
 * 17, 2026-10-09): the asker's sheet leaves the hand out, and each candidate
 * adds its own.
 */
describe("a weapon's own rows", () => {
  it('count for the weapon that carries them', () => {
    const plain = sword(1, 'longsword', 5, 10, 1500);
    const keen = { ...sword(2, 'keen longsword', 5, 10, 1500), abilities: [[4, 5]] } as WorldItem;
    const [first, second] = slotGear(1, realm([plain, keen]), asker()).rows;
    expect(first!.name).toBe('keen longsword');
    expect(first!.perRound!.value).toBeGreaterThan(second!.perRound!.value);
  });

  it('leave the asker when the hand holds them', () => {
    const state: CharacterState = {
      ...EMPTY_CHARACTER,
      inventory: {
        ...EMPTY_CHARACTER.inventory,
        items: [
          {
            name: 'keen longsword',
            slot: 'Weapon Hand',
            source: 'wire',
            equipped: true,
            charges: null,
            kind: 'weapon',
            abilities: [[4, 5]]
          },
          {
            name: 'ruby ring',
            slot: 'Finger',
            source: 'wire',
            equipped: true,
            charges: null,
            abilities: [[4, 2]]
          }
        ]
      }
    };
    const made = slotAskerOf(
      state,
      null,
      { combat: 4, magery: null, crits: 0, family: 'greatermud' },
      'a'
    );
    expect(made.sheet.effects?.maxDamage).toBe(2);
  });
});
