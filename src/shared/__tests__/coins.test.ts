import { describe, expect, it } from 'vitest';

import {
  chargedInCopper,
  COPPER_PER,
  counterPriceInCopper,
  currencyOfCode,
  quotedInCopper
} from '../coins';

/*
 * The ladder is what the eight listings-against-totals measured; the pairs
 * here are three of them, so a change to a rung fails against the wire and
 * not against taste.
 */
describe('the coin ladder', () => {
  it('is ×10, ×10, ×100, ×100', () => {
    expect(COPPER_PER).toEqual({
      copper: 1,
      silver: 10,
      gold: 100,
      platinum: 10_000,
      runic: 1_000_000
    });
  });

  it('reproduces the measured totals', () => {
    // live: 51 gold, 7 copper -> 5,107
    expect(quotedInCopper('51 gold crowns')! + quotedInCopper('7 copper farthings')!).toBe(5107);
    // captures/065
    expect(quotedInCopper('12 platinum pieces')).toBe(120_000);
    // captures/044
    expect(
      quotedInCopper('65 runic coins')! +
        quotedInCopper('51 platinum pieces')! +
        quotedInCopper('118 gold crowns')!
    ).toBe(65_521_800);
  });
});

describe('a quoted shop price', () => {
  it('reads the words a counter prints', () => {
    expect(quotedInCopper('20 gold crowns')).toBe(2000);
    expect(quotedInCopper('20 platinum pieces')).toBe(200_000);
    expect(quotedInCopper('1,250 copper farthings')).toBe(1250);
  });

  /* The realm prints it for a starter shop, and it means exactly that. */
  it('reads Free as nothing to pay', () => {
    expect(quotedInCopper('Free')).toBe(0);
  });

  /* captures/024 renames the runic coin: a noun this table does not know is
     unknown, never zero. */
  it('refuses a denomination it does not know', () => {
    expect(quotedInCopper('4 dime bags')).toBeNull();
    expect(quotedInCopper('a song')).toBeNull();
  });
});

/*
 * `BuyCommand.TryToBuy`'s arithmetic, checked against the two figures the wire
 * gave: a waterskin (Price 25, Currency 1) at the General Store (markup 100)
 * quoted 50 silver nobles, and a short-spear (Price 2, Currency 2) sold for
 * 400 copper.
 */
describe("a counter's price", () => {
  it('reads the realm coin codes in the server order', () => {
    expect([0, 1, 2, 3, 4, 5].map(currencyOfCode)).toEqual([
      'copper',
      'silver',
      'gold',
      'platinum',
      'runic',
      null
    ]);
  });

  it('multiplies the coin through the markup', () => {
    expect(counterPriceInCopper(25, 'silver', 100)).toBe(500);
    expect(counterPriceInCopper(2, 'gold', 100)).toBe(400);
    expect(counterPriceInCopper(0, 'silver', 100)).toBe(0);
  });

  it('takes charm off above 50 and adds it below, and prices an unread charm at the floor', () => {
    expect(chargedInCopper(500, 50)).toBe(500);
    expect(chargedInCopper(500, 54)).toBe(500);
    expect(chargedInCopper(500, 70)).toBe(480);
    expect(chargedInCopper(500, 40)).toBe(510);
    expect(chargedInCopper(500, null)).toBe(550);
  });
});
