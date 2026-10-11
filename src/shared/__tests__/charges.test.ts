import { describe, expect, it } from 'vitest';

import { chargeCapacity, chargesAfter, renews, type Charged } from '../charges';

// The realm's own rows (resources/world/paradigm.jsonl.gz, gmud.zip's Retain After Uses).
const CLOAK_OF_FAITH = {
  uses: 3,
  retains: true as const,
  abilities: [
    [121, 3],
    [43, 872]
  ] as Array<[number, number]>
};
const BONE_NECKLACE = {
  uses: 10,
  retains: true as const,
  abilities: [
    [121, 5],
    [43, 1249]
  ] as Array<[number, number]>
};
const GREEN_POTION = { uses: 1, abilities: [[43, 200]] as Array<[number, number]> };

const charged = (item: Parameters<typeof chargeCapacity>[0]): Charged => {
  const capacity = chargeCapacity(item);
  if (capacity?.kind !== 'charged') throw new Error('not charged');
  return capacity;
};

describe('what a charged item holds', () => {
  it('reads UseCount, Recharge and Retain After Uses, and silence as unknown', () => {
    expect(chargeCapacity(CLOAK_OF_FAITH)).toEqual({
      kind: 'charged',
      of: 3,
      daily: 3,
      retains: true
    });
    expect(chargeCapacity(GREEN_POTION)).toEqual({
      kind: 'charged',
      of: 1,
      daily: 0,
      retains: false
    });
    expect(chargeCapacity({ uses: -1 })).toEqual({ kind: 'unlimited' });
    expect(chargeCapacity({})).toBeNull();
  });

  it('renews only an unlimited item or one kept and recharged', () => {
    expect(renews(charged(CLOAK_OF_FAITH))).toBe(true);
    expect(renews({ kind: 'unlimited' })).toBe(true);
    expect(renews(charged(GREEN_POTION))).toBe(false);
    // Recharged but destroyed at its last use: the use that empties it is not given back.
    expect(renews(charged({ ...CLOAK_OF_FAITH, retains: undefined }))).toBe(false);
  });
});

describe('a copy’s uses left', () => {
  const cloak = charged(CLOAK_OF_FAITH);

  it('stays unknown until the wire says, and a use of an unknown count says nothing', () => {
    expect(chargesAfter(null, cloak, { kind: 'used' })).toBeNull();
    const looked = chargesAfter(null, cloak, { kind: 'looked', uses: 2 });
    expect(looked).toBe(2);
    expect(chargesAfter(looked, cloak, { kind: 'used' })).toBe(1);
    expect(chargesAfter(looked, cloak, { kind: 'used-up' })).toBe(0);
  });

  it('fills at the cleanup when the recharge is the whole UseCount', () => {
    expect(chargesAfter(null, cloak, { kind: 'new-day' })).toBe(3);
  });

  it('adds a part recharge only to a known count, capped', () => {
    const necklace = charged(BONE_NECKLACE);
    expect(chargesAfter(null, necklace, { kind: 'new-day' })).toBeNull();
    expect(chargesAfter(7, necklace, { kind: 'new-day' })).toBe(10);
    expect(chargesAfter(2, necklace, { kind: 'new-day' })).toBe(7);
  });

  it('gives nothing back to an item with no recharge', () => {
    expect(chargesAfter(0, charged(GREEN_POTION), { kind: 'new-day' })).toBe(0);
  });

  it('keeps a look as read where the realm states no count, and forgets it at the cleanup', () => {
    expect(chargesAfter(null, null, { kind: 'looked', uses: 9 })).toBe(9);
    expect(chargesAfter(9, null, { kind: 'new-day' })).toBeNull();
  });
});
