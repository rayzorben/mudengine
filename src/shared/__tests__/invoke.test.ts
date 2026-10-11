import { describe, expect, it } from 'vitest';

import { wireItem } from '../entities';
import {
  carriedBlessing,
  chosenToInvoke,
  invokeChoices,
  itemBlessing,
  renewingBlessing,
  type BlessingRealm
} from '../invoke';
import type { WorldItem, WorldSpell } from '../world';

const BLESS: WorldSpell = {
  id: 114,
  name: 'weapon major bless',
  mana: 8,
  duration: 60,
  targets: 13
};
const ITEMS: Record<string, WorldItem> = {
  'shimmering longsword': {
    id: 1,
    name: 'shimmering longsword',
    kind: 'weapon',
    uses: -1,
    abilities: [[43, 114]]
  },
  'arcane tome': { id: 2, name: 'arcane tome', kind: 'misc', uses: -1, abilities: [[43, 114]] },
  'unknown rod': { id: 3, name: 'unknown rod', uses: -1, abilities: [[43, 114]] },
  'charged wand': { id: 4, name: 'charged wand', kind: 'misc', uses: 3, abilities: [[43, 114]] },
  // gmud.zip's cloak of faith: 3 uses, kept at none, 3 back at each cleanup.
  'cloak of faith': {
    id: 5,
    name: 'cloak of faith',
    kind: 'armour',
    uses: 3,
    retains: true,
    abilities: [
      [121, 3],
      [43, 114]
    ]
  }
};
const realm: BlessingRealm = {
  itemsNamed: (names) => Object.fromEntries(names.map((name) => [name, ITEMS[name]])),
  spellById: (id) => (id === 114 ? BLESS : null)
};
const carried = (name: string, equipped: boolean) => ({ ...wireItem(name), equipped });

describe('the blessing a carried item casts', () => {
  it('needs a weapon wielded, and an item of unstated kind is taken as one', () => {
    expect(carriedBlessing('shimmering longsword', realm)?.mustBeEquipped).toBe(true);
    expect(carriedBlessing('unknown rod', realm)?.mustBeEquipped).toBe(true);
    expect(carriedBlessing('arcane tome', realm)?.mustBeEquipped).toBe(false);
  });

  it('refuses an item with charges', () => {
    expect(carriedBlessing('charged wand', realm)).toBeNull();
  });

  it('reads a charged item through itemBlessing, with what a copy holds', () => {
    expect(itemBlessing('charged wand', realm)?.capacity).toEqual({
      kind: 'charged',
      of: 3,
      daily: 0,
      retains: false
    });
    expect(itemBlessing('shimmering longsword', realm)?.capacity).toEqual({ kind: 'unlimited' });
  });

  it('uses a charged item only when it is kept and recharged', () => {
    expect(carriedBlessing('cloak of faith', realm)).toBeNull();
    expect(renewingBlessing('cloak of faith', realm)?.spell).toBe(BLESS);
    expect(renewingBlessing('charged wand', realm)).toBeNull();
    expect(renewingBlessing('shimmering longsword', realm)?.spell).toBe(BLESS);
  });

  it('lists a recharged item with the uses the ledger last read', () => {
    const [cloak] = invokeChoices([carried('cloak of faith (Back)', true)], realm, () => 2);
    expect(cloak?.charges).toEqual({ of: 3, daily: 3, left: 2 });
  });

  it('lists each item once, the wielded one where two are carried', () => {
    const choices = invokeChoices(
      [
        carried('shimmering longsword', false),
        carried('shimmering longsword (Weapon Hand)', true),
        carried('charged wand', false)
      ],
      realm,
      () => null
    );
    expect(choices).toEqual([
      {
        item: 'shimmering longsword',
        spell: 'weapon major bless',
        mana: 8,
        equipped: true,
        mustBeEquipped: true,
        party: true,
        charges: null
      }
    ]);
  });

  // `FullPartyArea` (13) lands on the party in the room; anything else is not said to.
  it('says whether the spell lands on the whole party', () => {
    const own: BlessingRealm = {
      ...realm,
      spellById: (id) => (id === 114 ? { ...BLESS, targets: 1 } : null)
    };
    expect(invokeChoices([carried('shimmering longsword', true)], own, () => null)[0]?.party).toBe(
      false
    );
  });

  it('matches a chosen name the way the pack spells it', () => {
    expect(chosenToInvoke(['Shimmering Longsword'], 'shimmering longsword')).toBe(true);
    expect(chosenToInvoke([], 'shimmering longsword')).toBe(false);
  });
});
