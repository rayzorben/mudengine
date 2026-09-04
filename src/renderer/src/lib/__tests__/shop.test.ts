import { describe, expect, it } from 'vitest';

import { affordable, mergeStock, priceValue } from '../shop';
import type { ShopListing } from '@shared/character';
import type { WorldShop } from '@shared/world';

/*
 * Jael's Missile Weapons: the realm file's rows as the shipped data has them
 * — `price` is `Items.Price` raw, and it is **not** copper: the counter sells
 * the `10` shortbow for `20 gold crowns` — and the counter's answer, live
 * 2026-08-27.
 */
const REALM: WorldShop = {
  id: 7,
  name: "Jael's Missile Weapons",
  items: [
    { id: 1, name: 'shortbow', price: 10 },
    { id: 2, name: 'staff-sling', price: 4 },
    { id: 3, name: 'sling', price: 5 }
  ]
};
const COUNTER: ShopListing = {
  at: 1,
  items: [
    { name: 'shortbow', quantity: 25, price: '20 gold crowns', note: "You can't use" },
    { name: 'runed longbow', quantity: 1, price: '20 platinum pieces', note: "You can't use" },
    { name: 'staff-sling', quantity: 3, price: '21 gold crowns', note: null }
  ]
};

describe('the realm stock and the counter, as one table', () => {
  it('shows the realm alone when nobody has asked', () => {
    const rows = mergeStock(REALM, null);
    expect(rows.map((row) => row.name)).toEqual(['shortbow', 'staff-sling', 'sling']);
    expect(rows.every((row) => row.listed === null && row.quoted === null)).toBe(true);
  });

  it('lets the counter speak for a thing both name', () => {
    const [shortbow] = mergeStock(REALM, COUNTER);
    expect(shortbow).toMatchObject({
      id: 1,
      realmPrice: 10,
      quoted: '20 gold crowns',
      quotedCopper: 2000,
      quantity: 25,
      note: "You can't use",
      listed: true
    });
  });

  /* A fact about today that the realm file cannot hold. */
  it('keeps a realm row the counter did not list, and says so', () => {
    const rows = mergeStock(REALM, COUNTER);
    expect(rows.find((row) => row.name === 'sling')).toMatchObject({ listed: false, quoted: null });
  });

  it('adds a thing the counter sells that the realm data does not know', () => {
    const rows = mergeStock(REALM, COUNTER);
    expect(rows.at(-1)).toMatchObject({
      name: 'runed longbow',
      id: null,
      realmPrice: null,
      quotedCopper: 200_000,
      listed: true
    });
  });

  it('is the listing alone where the realm data has no shop', () => {
    const rows = mergeStock(null, COUNTER);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.id === null && row.listed === true)).toBe(true);
  });
});

describe('what the price column sorts by', () => {
  /*
   * The file's figure and the counter's copper are different units, and a
   * column that mixed them put every unlisted `10` above every quoted `2000`.
   */
  it('is the counter, in copper, once a listing exists — and null for the unquoted', () => {
    const [shortbow, , sling] = mergeStock(REALM, COUNTER);
    expect(priceValue(shortbow!, COUNTER)).toBe(2000);
    expect(priceValue(sling!, COUNTER)).toBeNull();
  });

  it("is the file's own figure only while nobody has asked", () => {
    const [shortbow] = mergeStock(REALM, null);
    expect(priceValue(shortbow!, null)).toBe(10);
  });
});

describe('whether the purse covers it', () => {
  const [shortbow, staffSling, sling, longbow] = mergeStock(REALM, COUNTER);

  it('compares the quoted price in copper to the wealth in copper', () => {
    expect(affordable(shortbow!, 2000)).toBe(true);
    expect(affordable(shortbow!, 1999)).toBe(false);
    expect(affordable(longbow!, 199_999)).toBe(false);
    expect(affordable(staffSling!, 2100)).toBe(true);
  });

  /* Null is not zero, and an unasked counter is not a price. */
  it('cannot say without a quotation or a counted purse', () => {
    expect(affordable(sling!, 5_000_000)).toBeNull();
    expect(affordable(shortbow!, null)).toBeNull();
  });
});
