import { describe, expect, it } from 'vitest';

import { isStashEntry, stashRooms, withHidden, withTaken, type StashPlace } from '../stash';

const VAULT: StashPlace = { map: 1, room: 2150, name: 'Ganghouse, Vault' };
const GATE: StashPlace = { map: 1, room: 1, name: 'Newhaven, Village Entrance' };
const NOWHERE: StashPlace = { map: null, room: null, name: null };

describe('the stash record', () => {
  it('adds a second hide of the same item in the same room to its count', () => {
    const once = withHidden([], VAULT, 'torch', 3, 1);
    const twice = withHidden(once, VAULT, 'torch', 2, 5);
    expect(twice).toEqual([{ ...VAULT, item: 'torch', count: 5, at: 5 }]);
  });

  it('keeps one item hidden in two rooms as two entries', () => {
    const stash = withHidden(withHidden([], VAULT, 'torch', 1, 1), GATE, 'torch', 1, 2);
    expect(stash).toHaveLength(2);
  });

  it('takes a get in that room off the count, and the entry at none', () => {
    const stash = withHidden([], VAULT, 'torch', 3, 1);
    expect(withTaken(stash, VAULT, 'torch', 1)[0]?.count).toBe(2);
    expect(withTaken(stash, VAULT, 'torch', 3)).toEqual([]);
  });

  it('writes nothing for a get anywhere else, or in a room nobody placed', () => {
    const stash = withHidden([], VAULT, 'torch', 3, 1);
    expect(withTaken(stash, GATE, 'torch', 1)).toBe(stash);
    const unplaced = withHidden([], NOWHERE, 'torch', 1, 1);
    expect(withTaken(unplaced, NOWHERE, 'torch', 1)).toBe(unplaced);
  });

  it('reads an entry from the file only when every field is a fact', () => {
    const entry = { ...VAULT, item: 'torch', count: 3, at: 1 };
    expect(isStashEntry(entry)).toBe(true);
    expect(isStashEntry({ ...entry, map: null })).toBe(false);
    expect(isStashEntry({ ...entry, count: 0 })).toBe(false);
    expect(isStashEntry({ ...NOWHERE, item: 'torch', count: 1, at: 1 })).toBe(true);
  });

  it('groups by room for the card, the latest hide first, counts before names', () => {
    const stash = withHidden(
      withHidden(withHidden([], GATE, 'padded gloves', 1, 1), VAULT, 'torch', 3, 4),
      VAULT,
      'katana',
      1,
      2
    );
    expect(stashRooms(stash).map((room) => [room.name, room.items])).toEqual([
      ['Ganghouse, Vault', ['3 torch', 'katana']],
      ['Newhaven, Village Entrance', ['padded gloves']]
    ]);
  });
});
