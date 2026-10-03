import { describe, expect, it } from 'vitest';

import { wireItem } from '../entities';
import { carriedBlessing, chosenToInvoke, invokeChoices, type BlessingRealm } from '../invoke';
import type { WorldItem, WorldSpell } from '../world';

const BLESS: WorldSpell = { id: 114, name: 'weapon major bless', mana: 8, duration: 60 };
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
  'charged wand': { id: 4, name: 'charged wand', kind: 'misc', uses: 3, abilities: [[43, 114]] }
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

  it('lists each item once, the wielded one where two are carried', () => {
    const choices = invokeChoices(
      [
        carried('shimmering longsword', false),
        carried('shimmering longsword (Weapon Hand)', true),
        carried('charged wand', false)
      ],
      realm
    );
    expect(choices).toEqual([
      {
        item: 'shimmering longsword',
        spell: 'weapon major bless',
        mana: 8,
        equipped: true,
        mustBeEquipped: true
      }
    ]);
  });

  it('matches a chosen name the way the pack spells it', () => {
    expect(chosenToInvoke(['Shimmering Longsword'], 'shimmering longsword')).toBe(true);
    expect(chosenToInvoke([], 'shimmering longsword')).toBe(false);
  });
});
