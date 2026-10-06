import { describe, expect, it } from 'vitest';

import {
  asCoinNames,
  chargedInCopper,
  coinReader,
  coinsInCopper,
  COPPER_PER,
  counterPriceInCopper,
  currencyOf,
  currencyOfCode,
  expectedCopper,
  quotedInCopper,
  soldForCopper,
  takeCoins
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

/* MajorMUD's training receipt, bearfather's wire (todo 745). */
describe('coinsInCopper', () => {
  it('sums each part up the ladder, and reads nothing as zero', () => {
    expect(coinsInCopper(['5 silver nobles'])).toBe(50);
    expect(coinsInCopper(['1 gold crown', '5 silver nobles'])).toBe(150);
    expect(coinsInCopper(['nothing'])).toBe(0);
  });

  it('is unknown when any part is unreadable, or when nothing was listed', () => {
    expect(coinsInCopper(['1 gold crown', '3 bronze bits'])).toBeNull();
    expect(coinsInCopper([])).toBeNull();
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

  /*
   * The wire, 2026-10-04: Soul (charm 60) sold a silk robe, 15 gold in the
   * realm's row, `for 825 copper farthings`: half of 1,500, and 10% of that.
   */
  it('pays half the base for a sale, charm counted from 50, an unread charm at the floor', () => {
    expect(soldForCopper(15, 'gold', 60)).toBe(825);
    expect(soldForCopper(15, 'gold', 50)).toBe(750);
    expect(soldForCopper(15, 'gold', 40)).toBe(675);
    expect(soldForCopper(15, 'gold', null)).toBe(375);
    expect(soldForCopper(0, 'silver', 60)).toBe(0);
  });
});

/* Coins picked up off the floor (todo 746). */
describe('takeCoins', () => {
  it('takes a count off one denomination, floored at none', () => {
    const floor = currencyOf({ silver: 3, gold: 1 });
    expect(takeCoins(floor, 'silver', 2)).toMatchObject({ silver: 1, gold: 1, totalCopper: 110 });
    expect(takeCoins(floor, 'silver', 5)).toMatchObject({ silver: 0, gold: 1 });
  });

  it('leaves a floor nothing has stated unstated', () => {
    expect(takeCoins(null, 'silver', 3)).toBeNull();
  });
});

/* Todo 830: a realm's own words for the coins it renamed, read back to the stock ones. */
describe('coinReader', () => {
  const reader = coinReader({ runic: 'dime bag' });

  it("reads a capture's renamed coin as the stock one", () => {
    // captures/024:260, the snakepits realm, where runic coins are dime bags.
    expect(
      reader.toStock('You are carrying 4 dime bags, 48 platinum pieces, 30 gold crowns, 5 silver')
    ).toBe('You are carrying 4 runic coins, 48 platinum pieces, 30 gold crowns, 5 silver');
    expect(reader.toStock('You picked up 1 dime bag.')).toBe('You picked up 1 runic coin.');
  });

  it('leaves the stock names and every other word alone', () => {
    const line = 'You are carrying 2 runic coins, 16 platinum pieces and a dimension door';
    expect(reader.toStock(line)).toBe(line);
    expect(coinReader({}).toStock('4 dime bags')).toBe('4 dime bags');
  });

  it("names a coin by the realm's word to pick it up, and the stock word otherwise", () => {
    expect(reader.word('runic')).toBe('dime');
    expect(reader.word('gold')).toBe('gold');
  });

  it('reads a coins: block, dropping what names no coin', () => {
    expect(asCoinNames({ runic: ' Dime Bag ', gold: '', silver: 7, lead: 'slug' })).toEqual({
      runic: 'dime bag'
    });
    expect(asCoinNames('nonsense')).toEqual({});
  });
});

describe('coinReader, narrowly', () => {
  it('reads only a name that follows a count, longest name first', () => {
    const reader = coinReader({ gold: 'crown', silver: 'dime', runic: 'dime bag' });
    expect(reader.toStock('a crown of thorns (Head)')).toBe('a crown of thorns (Head)');
    expect(reader.toStock('You have 2 crowns and 3 dime bags.')).toBe(
      'You have 2 gold crowns and 3 runic coins.'
    );
    expect(reader.toStock('5 dimes drop to the ground.')).toBe(
      '5 silver nobles drop to the ground.'
    );
  });
});

/*
 * `Mob.CreateCash`: each coin rolled 1 to its maximum inclusive where the
 * maximum is above none, so each pays (1 + max) / 2 on average.
 */
describe('expectedCopper', () => {
  const none = { runic: 0, platinum: 0, gold: 0, silver: 0, copper: 0 };

  it('reads a kobold thief, S 7 C 20, as 50.5 copper a kill', () => {
    expect(expectedCopper({ ...none, silver: 7, copper: 20 })).toBe(4 * 10 + 10.5);
  });

  it('is nothing for a monster that carries none', () => {
    expect(expectedCopper(none)).toBe(0);
  });

  it('counts every coin up the ladder', () => {
    expect(expectedCopper({ runic: 1, platinum: 1, gold: 1, silver: 1, copper: 1 })).toBe(
      COPPER_PER.runic + COPPER_PER.platinum + COPPER_PER.gold + COPPER_PER.silver + 1
    );
  });
});
