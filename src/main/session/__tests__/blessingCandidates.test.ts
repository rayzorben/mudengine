import { describe, expect, it } from 'vitest';

import { itemCandidates, type CandidatePricing } from '../blessingCandidates';
import { EMPTY_CHARACTER, type CarriedItem, type CharacterState } from '../../../shared/character';
import { wireItem } from '../../../shared/entities';
import { WEAPON_HAND } from '../../../shared/items';
import type { BlessingRealm } from '../../../shared/invoke';
import { prowessSheetOf } from '../../../shared/verdict';
import type { WorldItem, WorldSpell } from '../../../shared/world';
import type { WornReads } from '../../../shared/wornForUse';

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
/** One-handed weapons, and a slot per item where a test names one. */
const reads = (slots: Record<string, string> = {}): WornReads => ({
  handsOf: () => 1,
  slotOf: (name) => slots[name] ?? null
});
const ONE_HAND = reads();
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

  /* Armour in the pack: worn over the emblem, used, the emblem worn again. */
  it('prices armour in the pack as a swap, and leaves it not worn where its slot is unknown', () => {
    const cross: WorldItem = {
      ...ITEMS['black flail']!,
      name: 'large silvery cross',
      kind: 'armour'
    };
    const withCross: BlessingRealm = {
      ...realm,
      itemsNamed: (names) => Object.fromEntries(names.map((name) => [name, cross]))
    };
    const state = bare([carried('large silvery cross', false), carried('onyx emblem', true)]);
    const worn = reads({ 'large silvery cross': 'Worn', 'onyx emblem': 'Worn' });
    expect(itemCandidates(state, pricing(state), withCross, worn).map((each) => each.via)).toEqual([
      { kind: 'item', item: 'large silvery cross', hand: { kind: 'swap', commands: 2 } }
    ]);
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
