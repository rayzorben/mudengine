import { describe, expect, it } from 'vitest';

import { itemCandidates, type CandidatePricing } from '../blessingCandidates';
import { EMPTY_CHARACTER, type CarriedItem, type CharacterState } from '../../../shared/character';
import { wireItem } from '../../../shared/entities';
import { WEAPON_HAND } from '../../../shared/items';
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
const ONE_HAND = (): 1 => 1;
const carried = (name: string, equipped: boolean): CarriedItem => ({ ...wireItem(name), equipped });

describe('the carried items Auto Choose Blessings weighs', () => {
  /* The flail's swap: wielded, used, the longsword back (`offRoundPlan`). */
  it('takes an item that blesses the caster, worn or not, and never a curse', () => {
    const state = bare([
      { ...carried('shimmering longsword', true), slot: WEAPON_HAND },
      carried('black flail', false),
      carried('nightblack scythe', true)
    ]);
    const found = itemCandidates(state, pricing(state), realm, ONE_HAND);
    expect(found.map((each) => [each.name, each.via])).toEqual([
      [
        'shimmering longsword',
        { kind: 'item', item: 'shimmering longsword', hand: { kind: 'ready' } }
      ],
      ['black flail', { kind: 'item', item: 'black flail', hand: { kind: 'swap', commands: 2 } }]
    ]);
    expect(found[0]!.spell.id).toBe(114);
    expect(found[0]!.duration?.from).toBe('realm');
  });

  /* Armour goes in its own place, which the swap does not put back. */
  it('leaves armour in the pack not worn', () => {
    const cross: WorldItem = {
      ...ITEMS['black flail']!,
      name: 'large silvery cross',
      kind: 'armour'
    };
    const withCross: BlessingRealm = {
      ...realm,
      itemsNamed: (names) => Object.fromEntries(names.map((name) => [name, cross]))
    };
    const state = bare([carried('large silvery cross', false)]);
    expect(
      itemCandidates(state, pricing(state), withCross, ONE_HAND).map((each) => each.via)
    ).toEqual([{ kind: 'item', item: 'large silvery cross', hand: { kind: 'not-worn' } }]);
  });

  it('weighs nothing from a pack that has not been listed', () => {
    const state = bare([carried('shimmering longsword', true)], null);
    expect(itemCandidates(state, pricing(state), realm, ONE_HAND)).toEqual([]);
    // Positive control: the same pack, listed.
    const listed = bare([carried('shimmering longsword', true)]);
    expect(itemCandidates(listed, pricing(listed), realm, ONE_HAND)).toHaveLength(1);
  });
});
