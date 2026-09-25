import { describe, expect, it } from 'vitest';

import { worldOf } from '../../world/__tests__/realmFile';
import {
  EMPTY_CHARACTER,
  emptyRoom,
  type BankBalance,
  type CharacterState
} from '../../../shared/character';
import { NO_BELONGINGS } from '../../../shared/belongings';
import { CharacterTracker } from '../CharacterTracker';
import { coinsPickedUp, Ledger, takenByAnother } from '../ledger';
import { currencyOf } from '../../../shared/coins';
import { blockOf } from '../../../shared/__tests__/blocks';

/*
 * The order the ledger reaches out in, and when it lets go of the vault it
 * stands in (todo 700: *order is a decision*). The tracker's tests drive whole
 * blocks and assert the state that comes out, so they cannot see which of the
 * stock report, the pack's pending change and the written balances came
 * first; and a replay of a whole session never resets, leaves or walks to the
 * menu in the middle of one. So these hand `Ledger` sources that write down
 * each reach into them, and hand the forgetting to a real tracker.
 */

const T = 1_700_000_000_000;

/** A market whose shop the realm says stocks a lantern, and nothing else. */
const world = worldOf([{ m: 1, r: 20, n: 'Market Square', x: {}, s: 4 }], {
  v: 4,
  items: [{ id: 12, n: 'lantern' }],
  shops: [{ id: 4, n: 'General Store', items: [12] }]
});

/** A ledger whose every reach into what it was handed is logged, in order. */
function rig(): { log: string[]; ledger: Ledger } {
  const log: string[] = [];
  const ledger = new Ledger({
    world,
    onDiscovery: (found) => log.push(`stock ${found.name}`),
    notePack: (seq, item, gained, count) =>
      log.push(`pack ${gained ? '+' : '-'}${count} ${item} @${seq}`),
    belongings: () => ({
      rememberBanks: (banks) =>
        log.push(`banks ${banks.map((bank) => `${bank.shop ?? '-'}:${bank.copper}`).join(' ')}`)
    })
  });
  return { log, ledger };
}

/** In the market, 1,000 copper in the purse, carrying nothing, and `banks` on record. */
function shopper(banks: BankBalance[] = []): CharacterState {
  const fresh = structuredClone(EMPTY_CHARACTER);
  return {
    ...fresh,
    phase: 'in-game',
    room: { ...emptyRoom(), name: 'Market Square', map: 1, number: 20 },
    inventory: { ...fresh.inventory, wealth: 1000 },
    banks
  };
}

const GODFREY = { bank: 'Bank of Godfrey', copper: '500' };

describe('the order a counter reaches out in', () => {
  it('checks the stock before the pack hears of a purchase, then spends the quote', () => {
    const { log, ledger } = rig();
    const s = ledger.bought(
      shopper(),
      { item: 'rope', quantity: '2', price: '40', coin: 'copper farthings' },
      7
    );
    expect(log).toEqual(['stock rope', 'pack +2 rope @7']);
    expect(s?.inventory.items.map((item) => item.name)).toEqual(['rope', 'rope']);
    expect(s?.inventory.wealth).toBe(960);
  });

  it('checks every row the counter printed, in its order, kept or not', () => {
    const { log, ledger } = rig();
    const s = ledger.shopListed(
      shopper(),
      [
        { item: 'rope', quantity: '5', price: '20 copper farthings' },
        { item: 'lantern', quantity: '1', price: '4 copper farthings' },
        { item: 'pebble', quantity: '9', price: '' }
      ],
      T
    );
    expect(log).toEqual(['stock rope', 'stock pebble']);
    expect(s?.shopListing?.items.map((item) => item.name)).toEqual(['rope', 'lantern']);
  });

  it('tells the pack of a sale and nothing else, and puts nothing on the floor', () => {
    const { log, ledger } = rig();
    const holding = ledger.bought(
      shopper(),
      { item: 'lantern', price: '4', coin: 'copper farthings' },
      1
    )!;
    log.length = 0;
    const s = ledger.sold(holding, { item: 'lantern', price: '2' }, 9);
    expect(log).toEqual(['pack -1 lantern @9']);
    expect(s?.inventory.items).toEqual([]);
    expect(s?.room.items).toEqual([]);
    expect(s?.inventory.wealth).toBe(998);
  });
});

describe('the vault a deposit moves', () => {
  it('writes the merged list when a vault states one, and again once a deposit has moved it', () => {
    const { log, ledger } = rig();
    const s = ledger.balanceStated(
      shopper([{ shop: 185, name: 'Albion', copper: 7, at: T }]),
      GODFREY,
      T
    )!;
    expect(log).toEqual(['banks 185:7 -:500']);
    const after = ledger.banked(s, 100, false, T + 1);
    expect(log).toEqual(['banks 185:7 -:500', 'banks 185:7 -:600']);
    expect(after?.inventory.wealth).toBe(900);
  });

  it('moves the vault the last `bank` here named', () => {
    const { ledger } = rig();
    let s = ledger.balanceStated(shopper(), GODFREY, T)!;
    s = ledger.balanceStated(s, { bank: 'Rhudaur Bank', copper: '42' }, T + 1)!;
    s = ledger.banked(s, 8, false, T + 2)!;
    expect(s.banks.map((bank) => [bank.name, bank.copper])).toEqual([
      ['Bank of Godfrey', 500],
      ['Rhudaur Bank', 50]
    ]);
  });

  /*
   * A record can hold one vault twice, unided and ided, when it was read on
   * GreaterMUD and then on a realm that prints the id. The id is the key, so
   * it is searched across every row before the name is.
   */
  it('finds the vault by its id before its name', () => {
    const { ledger } = rig();
    const record: BankBalance[] = [
      { shop: null, name: 'Bank of Godfrey', copper: 50, at: T },
      { shop: 8, name: 'Bank of Godfrey', copper: 100, at: T }
    ];
    let s = ledger.balanceStated(shopper(record), { ...GODFREY, copper: '100', shop: '8' }, T)!;
    s = ledger.banked(s, 10, false, T + 1)!;
    expect(s.banks.map((bank) => [bank.shop, bank.copper])).toEqual([
      [null, 50],
      [8, 110]
    ]);
  });

  /*
   * Standing in a vault is what a stated balance earns: a header whose figure
   * did not read names none, so a deposit after it has nothing to move.
   */
  it('names the vault only once its figure has been read', () => {
    const { log, ledger } = rig();
    const held = shopper([{ shop: null, name: 'Bank of Godfrey', copper: 500, at: T }]);
    expect(ledger.balanceStated(held, { bank: 'Bank of Godfrey' }, T)).toBeNull();
    expect(ledger.banked(held, 100, false, T + 1)?.banks[0]?.copper).toBe(500);
    expect(log).toEqual([]);
  });

  it('moves the purse and writes nothing when no bank has answered here', () => {
    const { log, ledger } = rig();
    expect(ledger.banked(shopper(), 100, true, T)?.inventory.wealth).toBe(1100);
    expect(log).toEqual([]);
  });

  it('changes nothing for a purse nobody counted and no vault to move', () => {
    const { ledger } = rig();
    const uncounted = { ...shopper(), inventory: structuredClone(EMPTY_CHARACTER.inventory) };
    expect(ledger.banked(uncounted, 100, false, T)).toBeNull();
  });
});

describe('what the ledger lets go of', () => {
  it('drops the quotation and the vault when the character stands somewhere else', () => {
    const { log, ledger } = rig();
    let s = ledger.balanceStated(shopper(), GODFREY, T)!;
    s = ledger.shopListed(s, [{ item: 'lantern', price: 'Free' }], T)!;
    s = ledger.roomChanged(s);
    expect(s.shopListing).toBeNull();
    log.length = 0;
    expect(ledger.banked(s, 100, false, T + 1)?.banks[0]?.copper).toBe(500);
    expect(log).toEqual([]);
  });

  it('hands back the same state when there was no quotation to drop', () => {
    const { ledger } = rig();
    const s = shopper();
    expect(ledger.roomChanged(s)).toBe(s);
  });

  it('stands in no bank once forgotten', () => {
    const { ledger } = rig();
    const s = ledger.balanceStated(shopper(), GODFREY, T)!;
    ledger.forget();
    expect(ledger.banked(s, 100, false, T + 1)?.banks[0]?.copper).toBe(500);
  });
});

describe('when the tracker makes the ledger forget', () => {
  /*
   * A tracker in the realm with Godfrey's balance on record and just stated
   * in this room, so a deposit has a vault to move — and a record that hands
   * the balance back at a new connection, so a vault kept through a reset
   * would find it to move.
   */
  const standingInGodfrey = (): CharacterTracker => {
    const kept = [{ shop: null, name: 'Bank of Godfrey', copper: 500, at: T }];
    const tracker = new CharacterTracker();
    tracker.useBelongings({ ...NO_BELONGINGS, recallBanks: () => kept });
    tracker.reset();
    tracker.apply(blockOf('status-line', '[HP=10/20]:', {}, T));
    tracker.apply(blockOf('bank-balance', 'On deposit: 500', GODFREY, T + 1));
    return tracker;
  };
  const deposit = (tracker: CharacterTracker): number | undefined => {
    tracker.apply(
      blockOf('user-deposits', 'You deposit 100 copper farthings.', { amount: '100' }, T + 9)
    );
    return tracker.current.banks[0]?.copper;
  };

  it('moves the vault while nothing has been forgotten', () => {
    const tracker = standingInGodfrey();
    expect(tracker.current.phase).toBe('in-game');
    expect(deposit(tracker)).toBe(600);
  });

  it('at a new connection', () => {
    const tracker = standingInGodfrey();
    tracker.reset();
    expect(tracker.current.banks[0]?.copper).toBe(500);
    expect(deposit(tracker)).toBe(500);
  });

  it('when the socket closes', () => {
    const tracker = standingInGodfrey();
    tracker.leaveRealm(T + 2);
    expect(deposit(tracker)).toBe(500);
  });

  it('when the character walks out to the menu', () => {
    const tracker = standingInGodfrey();
    tracker.apply(blockOf('prompt-character', 'Please select a character:', {}, T + 2));
    expect(tracker.current.phase).toBe('authenticating');
    expect(tracker.current.banks[0]?.copper).toBe(500);
    expect(deposit(tracker)).toBe(500);
  });
});

/*
 * Which pile a pick-up came off, as `GetCommand` decides it (GreaterMUD
 * `GetCommand.cs:88-110`, `:176-195`): the visible coins when that pile holds
 * the count, else what a search turned up. Wire: `logs/2026-09-02_23-03-32_festus`
 * `:1139-1143`, a search's `4 copper farthings` picked up (todo 746).
 */
describe('coins picked up off the floor', () => {
  const floor = (cash: number | null, hidden: number | null): CharacterState => ({
    ...structuredClone(EMPTY_CHARACTER),
    room: {
      ...emptyRoom(),
      cash: cash === null ? null : currencyOf({ gold: cash }),
      hiddenCash: hidden === null ? null : currencyOf({ gold: hidden })
    }
  });

  it('takes from the visible pile when it holds the count', () => {
    const { room } = coinsPickedUp(floor(5, 20), 5, 'gold crowns');
    expect([room.cash?.gold, room.hiddenCash?.gold]).toEqual([0, 20]);
  });

  it('takes from what a search turned up when the visible pile is short', () => {
    const { room } = coinsPickedUp(floor(5, 20), 20, 'gold crowns');
    expect([room.cash?.gold, room.hiddenCash?.gold]).toEqual([5, 0]);
  });

  it('leaves a floor neither pile explains as it was stated', () => {
    const s = floor(null, null);
    expect(coinsPickedUp(s, 3, 'gold crowns').room).toBe(s.room);
  });
});

/*
 * Somebody else picking coins up says `some`, never a count
 * (`GetCommand.cs:106`, `:188`; `captures/019`:185-187, `Faramir picks up some
 * gold crowns.`), and the server takes it from either pile. So the pile that
 * held that coin is unknown until the next listing (todo 757).
 */
describe('coins another player picked up', () => {
  const floor = (): CharacterState => ({
    ...structuredClone(EMPTY_CHARACTER),
    room: {
      ...emptyRoom(),
      cash: currencyOf({ gold: 5 }),
      hiddenCash: currencyOf({ silver: 2 })
    }
  });

  it('leaves the pile that held the coin unknown, and the other alone', () => {
    const { room } = takenByAnother(floor(), 'some gold crowns', 1);
    expect(room.cash).toBeNull();
    expect(room.hiddenCash?.silver).toBe(2);
  });
});
