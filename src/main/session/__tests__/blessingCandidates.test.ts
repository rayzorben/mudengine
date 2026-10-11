import { describe, expect, it } from 'vitest';

import { itemCandidates, type CandidatePricing } from '../blessingCandidates';
import { EMPTY_CHARACTER, type CarriedItem, type CharacterState } from '../../../shared/character';
import { wireItem } from '../../../shared/entities';
import type { BlessingRealm } from '../../../shared/invoke';
import { prowessSheetOf } from '../../../shared/verdict';
import type { WorldItem, WorldSpell } from '../../../shared/world';

/** `weapon major bless` as the shipped realm carries it: party target, accuracy by power. */
const BLESS: WorldSpell = {
  id: 114,
  name: 'weapon major bless',
  mana: 8,
  duration: 60,
  targets: 13,
  abilities: [[22, 0]],
  power: [10, 10]
};
/** The nightblack scythe's `disease`: a lasting spell that lands on an enemy. */
const DISEASE: WorldSpell = {
  id: 952,
  name: 'disease',
  duration: 30,
  targets: 8,
  abilities: [[22, 0]],
  power: [-10, -10]
};
const ITEMS: Record<string, WorldItem> = {
  'shimmering longsword': {
    id: 1,
    name: 'shimmering longsword',
    kind: 'weapon',
    uses: -1,
    abilities: [[43, 114]]
  },
  'black flail': { id: 2, name: 'black flail', kind: 'weapon', uses: -1, abilities: [[43, 114]] },
  'nightblack scythe': {
    id: 3,
    name: 'nightblack scythe',
    kind: 'weapon',
    uses: -1,
    abilities: [[43, 952]]
  }
};
const realm: BlessingRealm = {
  itemsNamed: (names) => Object.fromEntries(names.map((name) => [name, ITEMS[name]])),
  spellById: (id) => (id === 114 ? BLESS : id === 952 ? DISEASE : null)
};

function bare(items: CarriedItem[], listedAt: number | null = 1_000): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    progress: { ...base.progress, level: 12 },
    inventory: { ...base.inventory, items, listedAt }
  };
}

const pricing = (state: CharacterState): CandidatePricing => ({
  level: 12,
  sheet: prowessSheetOf(state, { combat: 3, magery: 1, crits: 0 }),
  family: 'greatermud',
  speed: 1,
  learnedDuration: () => null
});
const carried = (name: string, equipped: boolean): CarriedItem => ({ ...wireItem(name), equipped });

describe('the carried items Auto Choose Blessings weighs', () => {
  it('takes an item that blesses the caster, worn or not, and never a curse', () => {
    const state = bare([
      carried('shimmering longsword', true),
      carried('black flail', false),
      carried('nightblack scythe', true)
    ]);
    const found = itemCandidates(state, pricing(state), realm);
    expect(found.map((each) => [each.name, each.via])).toEqual([
      ['shimmering longsword', { kind: 'item', item: 'shimmering longsword', inHand: true }],
      ['black flail', { kind: 'item', item: 'black flail', inHand: false }]
    ]);
    expect(found[0]!.spell.id).toBe(114);
    expect(found[0]!.duration?.from).toBe('realm');
  });

  it('weighs nothing from a pack that has not been listed', () => {
    const state = bare([carried('shimmering longsword', true)], null);
    expect(itemCandidates(state, pricing(state), realm)).toEqual([]);
    // Positive control: the same pack, listed.
    const listed = bare([carried('shimmering longsword', true)]);
    expect(itemCandidates(listed, pricing(listed), realm)).toHaveLength(1);
  });
});
