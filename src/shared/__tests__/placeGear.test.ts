import { describe, expect, it } from 'vitest';

import { exposureAt, placeChoice, savedBy, type PlaceItem } from '../placeGear';
import type { WorldSpell } from '../world';

const RESIST_FIRE = 5;
const RESIST_COLD = 3;

const spell = (id: number, element: WorldSpell['element'], power: [number, number]): WorldSpell =>
  ({ id, name: `spell ${id}`, element, power, abilities: [[1, 0]] }) as WorldSpell;
const SPELLS = new Map<number, WorldSpell>([
  [1, spell(1, 'fire', [10, 30])],
  [2, spell(2, 'cold', [6, 6])],
  [3, { ...spell(3, 'fire', [50, 50]), abilities: [[18, 10]] }]
]);
const byId = (id: number): WorldSpell | null => SPELLS.get(id) ?? null;

const item = (name: string, over: Partial<PlaceItem>): PlaceItem => ({
  name,
  slot: 'torso',
  equipped: false,
  abilities: [],
  armour: { ac: 20, dr: 0 },
  ...over
});

describe('what a place deals by element', () => {
  it('adds the room spell per round and the worst lair row', () => {
    const lair = [
      {
        profiles: [
          {
            attacks: [
              {
                kind: 'spell' as const,
                chance: 0.5,
                spell: 2,
                castChance: 1,
                level: 0,
                energy: 500
              }
            ],
            casts: []
          }
        ]
      },
      { profiles: [{ attacks: [], casts: [{ spell: 2, chance: 1, level: 0 }] }] }
    ];
    const out = exposureAt(byId(1), lair, byId);
    expect(out.fire).toBeCloseTo((20 * 5) / 6);
    // 1,000 energy over 0.5 × 500 a swing is four swings, each casting half the time.
    expect(out.cold).toBeCloseTo(12);
  });

  it('counts a hit spell on every blow, the unsafe case', () => {
    const blow = { kind: 'melee' as const, chance: 1, energy: 500, min: 1, max: 2, accuracy: 10 };
    const lair = [{ profiles: [{ attacks: [{ ...blow, onHit: 2 }], casts: [] }] }];
    // Two swings a round, each landing a 6-point cold spell.
    expect(exposureAt(null, lair, byId).cold).toBeCloseTo(12);
  });

  it('counts nothing for a spell that does no damage', () => {
    expect(exposureAt(byId(3), [], byId)).toEqual({});
  });
});

describe('which carried armour answers it', () => {
  it('takes the resisting item over the worn one when it saves enough', () => {
    const items = [
      item('leather tunic', { equipped: true }),
      item('skirts of flame', { abilities: [[RESIST_FIRE, 25]] })
    ];
    expect([...placeChoice({ fire: 20 }, items, 2)]).toEqual([['torso', 'skirts of flame']]);
    expect(savedBy(items[1]!, { fire: 20, cold: 10 })).toBe(5);
  });

  it('refuses a swap that gives up armour or rests on an unknown', () => {
    const lighter = [
      item('plate', { equipped: true, armour: { ac: 40, dr: 0 } }),
      item('skirts of flame', { abilities: [[RESIST_FIRE, 25]] })
    ];
    expect(placeChoice({ fire: 20 }, lighter, 2).size).toBe(0);
    const unknown = [
      item('plate', { equipped: true, armour: null }),
      item('skirts of flame', { abilities: [[RESIST_FIRE, 25]] })
    ];
    expect(placeChoice({ fire: 20 }, unknown, 2).size).toBe(0);
  });

  it('ignores a resistance to an element the place does not deal', () => {
    const items = [item('fur cloak', { abilities: [[RESIST_COLD, 25]] })];
    expect(placeChoice({ fire: 20 }, items, 2).size).toBe(0);
    expect(placeChoice({ cold: 20 }, items, 2).size).toBe(1);
  });
});
