import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CarriedItem, type Inventory } from '@shared/character';
import { isToken, loadOf, packOf, weightOf } from '../packGroups';
import { wornSlotsOf } from '../wornSlots';

const item = (name: string, over: Partial<CarriedItem> = {}): CarriedItem =>
  ({ name, slot: null, equipped: false, charges: null, source: 'listing', ...over }) as CarriedItem;

// Capture 065: the character's own inventory, cut down.
const listed: Inventory = {
  ...EMPTY_CHARACTER.inventory,
  listedAt: 1,
  items: [
    item('golden pike', { equipped: true, slot: 'Weapon Hand', kind: 'weapon', encumbrance: 225 }),
    item('white gold ring', { equipped: true, slot: 'Finger', kind: 'armour', encumbrance: 25 }),
    item('wedding band', { equipped: true, slot: 'Finger', kind: 'armour', encumbrance: 10 }),
    item('red rose', { equipped: true, slot: 'Worn', kind: 'armour', encumbrance: 0 }),
    item('vorpal sword', { kind: 'weapon', encumbrance: 150 }),
    item('rolled parchment', { kind: 'scroll', encumbrance: 15 }),
    item('turquoise potion', { kind: 'drink', encumbrance: 30, count: 3 }),
    item('severed head of Irikani', { encumbrance: 100 }),
    item('quest token', { kind: 'misc', encumbrance: 0 })
  ],
  keys: ['golden idol', 'black star key'],
  encumbrance: 3304,
  encumbranceMax: 4800,
  encumbranceWord: 'Heavy'
};

describe('the pack', () => {
  it('is unknown, not empty, until it is listed', () => {
    expect(packOf(EMPTY_CHARACTER.inventory)).toBeNull();
    expect(wornSlotsOf(EMPTY_CHARACTER.inventory)).toBeNull();
    expect(loadOf(EMPTY_CHARACTER.inventory)).toBeNull();
  });

  it('sorts items into sections, worn apart, tokens apart, nothing dropped', () => {
    const pack = packOf(listed)!;
    expect(pack.groups.worn.map((one) => one.name)).toEqual([
      'golden pike',
      'white gold ring',
      'wedding band',
      'red rose'
    ]);
    expect(pack.groups.gear.map((one) => one.name)).toEqual(['vorpal sword']);
    expect(pack.groups.use.map((one) => one.name)).toEqual(['turquoise potion']);
    expect(pack.groups.scroll.map((one) => one.name)).toEqual(['rolled parchment']);
    expect(pack.groups.other.map((one) => one.name)).toEqual(['severed head of Irikani']);
    expect(pack.tokens.map((one) => one.name)).toEqual(['quest token']);
  });

  it('knows a token by its name', () => {
    expect(isToken('quest token')).toBe(true);
    expect(isToken('No Token ')).toBe(true);
    expect(isToken('tokenized blade')).toBe(false);
  });

  it('weighs a count as that many, keeps unknown rows apart, and splits the load', () => {
    expect(weightOf([item('turquoise potion', { encumbrance: 30, count: 3 })])).toEqual({
      known: 90,
      unknown: 0
    });
    // A row the realm cannot weigh is counted as unknown, never as nothing.
    expect(
      weightOf([item('crimson scale helm'), item('elven boots', { encumbrance: 50 })])
    ).toEqual({
      known: 50,
      unknown: 1
    });
    expect(loadOf(listed)).toEqual({
      now: 3304,
      max: 4800,
      word: 'Heavy',
      worn: 260,
      carried: 355,
      rest: 2689
    });
  });

  it('puts two rings on the two Finger squares, in inventory order', () => {
    const worn = wornSlotsOf(listed)!;
    expect(worn.bySlot.get('4/0')?.name).toBe('white gold ring');
    expect(worn.bySlot.get('4/1')?.name).toBe('wedding band');
    expect(worn.bySlot.get('16/0')?.name).toBe('red rose');
    expect(worn.elsewhere).toEqual([]);
  });
});
