/**
 * Coins, banks and counters: what the character has to spend, what each vault
 * said it holds, and what crossed a shop's counter. Out of `CharacterTracker`
 * as its seventh cluster (`mudengine-wire` › `parts/tracker.md`), and beside
 * the pack (`inventory.ts`) rather than in it: an item and a coin are
 * different listings, seeded by different commands. The arithmetic a price or
 * a balance needs is `src/shared/coins.ts`'s and `balanceOf`'s; nothing here
 * converts a coin.
 */
import {
  balanceOf,
  coinNamed,
  type BankBalance,
  type CharacterState,
  type Denomination,
  type Room
} from '../../shared/character';
import type { BelongingsSink } from '../../shared/belongings';
import { coinsInCopper, quotedInCopper, takeCoins } from '../../shared/coins';
import type { CurrencyEntity } from '../../shared/entities';
import type { Discovery } from '../../shared/memory';
import { sameItem } from '../../shared/items';
import { figure } from '../../shared/values';
import { roomId } from '../../shared/world';
import type { WorldGraph } from '../world/WorldGraph';
import {
  coinsListed,
  list,
  parseCoinEntry,
  withItem,
  withoutItem,
  withoutRoomItem
} from './inventory';

/**
 * A purchase or a sale moving the purse, in the copper the server quoted.
 *
 * `You just bought crystal flask for 980 copper farthings.` and
 * `You sold crystal flask for 275 copper farthings.` both state an **exact
 * figure in copper**, which is the same unit `Wealth:` is normalised into — so
 * unlike a coin pick-up, where the denomination counts move and the total is
 * left for the next listing to restate, there is nothing to convert and no
 * guess to make. The item already moves between the pack and the shop; the
 * money did not, so a shop trip left the purse describing the character as it
 * was before it.
 *
 * **An unknown purse stays unknown.** Adding to or subtracting from `null`
 * would claim this transaction was the whole of it — the refusal the coin
 * pick-up already makes, for the same reason. And the figure is floored at
 * zero: a sale recorded against a stale total must never produce a negative
 * purse, which is a number no readout can mean anything by.
 *
 * The per-denomination counts are deliberately *not* touched. The server does
 * not say which coins it took or gave, and inventing a breakdown that adds up
 * to the right total would be a claim about the purse the wire never made; the
 * next `i` states all five.
 */
function withSpend(s: CharacterState, copper: number): CharacterState | null {
  const wealth = s.inventory.wealth;
  if (wealth === null || !Number.isFinite(copper) || copper === 0) return null;
  return { ...s, inventory: { ...s.inventory, wealth: Math.max(0, wealth + copper) } };
}

/**
 * Money left the purse: by the figure the server quoted, or, where the quote
 * is in words this client cannot price, by an amount nobody can say, so the
 * purse is unknown until the next listing rather than a confident wrong
 * figure (todos 745, 815).
 */
function spent(s: CharacterState, copper: number | null): CharacterState | null {
  if (copper !== null) return withSpend(s, -copper);
  return s.inventory.wealth === null ? null : { ...s, inventory: { ...s.inventory, wealth: null } };
}

/**
 * Records what one bank just said, leaving every other bank alone.
 *
 * **A merge, against this state's own habit.** Every other listing here is
 * authoritative and replaces what it found; `bank` is authoritative about the
 * vault the character is standing in and silent about all the others, so
 * replacing would empty six banks on the word of a command that named one.
 *
 * Matched on the realm's shop id where both sides have one — the only stable
 * key, because the printed name varies by realm — and on the folded name
 * otherwise. An entry that gains an id later (the character banks the same
 * vault on a realm that prints one) matches by name and keeps the id.
 */
function withBankBalance(s: CharacterState, said: BankBalance): CharacterState {
  /*
   * The id is searched across the **whole** list before the name is considered
   * at all (`balanceOf`), and the two passes are why.
   *
   * One pass with the choice made per entry takes the first row that matches
   * *either* rule, and an unided row whose name folds the same way sits ahead
   * of the ided row for the same vault — so `Bank of Godfrey (#8)` arriving
   * against a list holding both matched the unided one, updated it, and left
   * the ided row behind. Two rows, one id, one name, two figures, and the
   * card's total counting the vault twice on the one card whose whole subject
   * is money. A character read on GreaterMUD, reconnected to a realm that
   * prints the id, then re-read walks straight through it.
   */
  const matched = balanceOf({ id: said.shop, name: said.name }, s.banks);
  const index = matched === null ? -1 : s.banks.indexOf(matched);

  if (index === -1) return { ...s, banks: [...s.banks, said] };

  const banks = s.banks.map((held, at) =>
    at === index ? { ...said, shop: said.shop ?? held.shop } : held
  );
  return { ...s, banks };
}

/**
 * `wealth` — the purse in one line, and the cheapest seed there is.
 *
 * Captured live 2026-08-28: `You have 22 platinum pieces, 50 gold crowns,
 * 3 silver nobles, 4 copper farthings.` against a `Wealth: 225034` from
 * the same session — 220 000 + 5 000 + 30 + 4 on the measured ladder.
 *
 * It enumerates, exactly as the `i` listing does, so an unnamed
 * denomination is **zero**: see `coinsListed` for why.
 *
 * **The total is left alone.** `Wealth:` is the server's own arithmetic
 * over these five numbers, and computing it here would be the client
 * doing a sum it has no reason to do and could get wrong on a realm that
 * renamed a coin.
 *
 * **Every part must be a coin, or the line is nothing.** The pattern
 * matches `<number> <words>` because the noun is realm data, so this is
 * where a sentence of the same shape about something else is refused
 * rather than becoming a purse.
 */
export function wealthStated(s: CharacterState, said: string | undefined): CharacterState | null {
  const parts = list(said);
  if (parts.length === 0) return null;
  const counted = parts.map((entry) => parseCoinEntry(entry));
  if (counted.some((coin) => coin === null)) return null;
  return { ...s, inventory: { ...s.inventory, coins: coinsListed(counted) } };
}

/**
 * Which pile a pick-up came off, as the server decides it (GreaterMUD
 * `GetCommand.cs:88-110`, `:176-195`): the visible coins when that pile holds
 * the count, else what a search turned up when that one does. Neither, and
 * the floor is left as stated rather than guessed at (todo 746).
 */
function offTheFloor(room: Room, denomination: Denomination, count: number): Room {
  if (room.cash !== null && room.cash[denomination] >= count) {
    return { ...room, cash: takeCoins(room.cash, denomination, count) };
  }
  if (room.hiddenCash !== null && room.hiddenCash[denomination] >= count) {
    return { ...room, hiddenCash: takeCoins(room.hiddenCash, denomination, count) };
  }
  return room;
}

/**
 * Somebody else picked something up. Coins are said as `some gold crowns`,
 * never with a count (GreaterMUD `GetCommand.cs:106`, `:188`;
 * `captures/019`:185), and the server takes them from either pile, so the
 * pile that held that coin is unknown until the next listing (todo 757).
 * Anything else leaves the floor's item list by name and count.
 */
export function takenByAnother(s: CharacterState, item: string, count: number): CharacterState {
  const coin = /^some (.+)$/i.exec(item.trim());
  const denomination = coin ? coinNamed(coin[1]!) : undefined;
  if (denomination === undefined) return withoutRoomItem(s, item, count);
  const held = (pile: CurrencyEntity | null): CurrencyEntity | null =>
    pile !== null && pile[denomination] > 0 ? null : pile;
  return {
    ...s,
    room: { ...s.room, cash: held(s.room.cash), hiddenCash: held(s.room.hiddenCash) }
  };
}

/**
 * `You picked up 3 silver nobles.` — the denomination picked up counts up by
 * the lot, and nothing is converted; the next `i` listing states all five
 * again. The floor's coins are `room.cash`, never items, so the lot comes off
 * that and an item named after the coin (`silver holy amulet`, `copper key`)
 * stays where it lies (todo 746).
 */
export function coinsPickedUp(
  s: CharacterState,
  count: number | null,
  coin: string | undefined
): CharacterState {
  const picked = count ?? 0;
  const denomination = coinNamed(coin ?? '');
  if (denomination === undefined) return s;
  const room = offTheFloor(s.room, denomination, picked);
  /*
   * The denomination that was picked up goes up by one lot, and nothing
   * is converted.
   *
   * It used to add `count × COIN_IN_COPPER[coin]` to `wealth`, and that
   * table was wrong: measured against the corpus the ladder is 1 / 10 /
   * 100 / 10 000 / 1 000 000, not the ×10 rungs it held — so every
   * platinum piece picked up understated the purse by ten times and every
   * runic coin by a hundred. The table is gone rather than corrected,
   * because with the counts kept the client has no reason to convert
   * anything: `Wealth:` is the server's own arithmetic and the next
   * listing states it.
   *
   * A denomination nothing has counted yet stays uncounted. Adding to an
   * unknown would claim the pick-up was the whole purse — which is the
   * same refusal the old code already made about an unknown `wealth`.
   */
  const known = s.inventory.coins[denomination];
  if (known === null) return { ...s, room };
  return {
    ...s,
    room,
    inventory: {
      ...s.inventory,
      coins: { ...s.inventory.coins, [denomination]: known + picked }
    }
  };
}

/**
 * `You hand over 1200 copper farthings to train to the next level!`, or
 * MajorMUD's `You hand over 1 gold crown, 5 silver nobles and you receive
 * training…` — a purchase in every sense that matters here: the server
 * states an exact figure, and the money is gone. Read for the same reason `user-buys` is, and it was the last way
 * money left the purse that nothing moved.
 *
 * `vocabulary.test.ts` exempted this type for three phases as *"the price
 * of a level; wealth is re-read from the next listing"*. Nothing forces
 * that listing: two trains in a guild left the maintained purse 2,200
 * copper high for the rest of the walk back to Godfrey, and the Deposit
 * All button then asked the vault for money the character did not have —
 * which this server refuses in **silence**, so neither the player nor the
 * client had anything to read (`logs/2026-09-04_20-39-52_festus`, 1000 +
 * 1200 against a `Wealth:` that fell by exactly 2200).
 *
 * The level half of the receipt is `Routines`' — it asks `exp`, because a
 * level is what makes *Exp. needed* wrong. This is the other half.
 */
export function trained(s: CharacterState, said: string | undefined): CharacterState | null {
  // GreaterMUD's sentence fixes the coin and captures the digits; MajorMUD's
  // names the coins, `5 silver nobles`, and was read as five copper (todo 745).
  return spent(s, /^\d+$/.test(said ?? '') ? figure(said) : coinsInCopper(list(said)));
}

/** Which shop a room is and what it stocks, as the realm states them. */
type StockWorld = Pick<WorldGraph, 'byId' | 'shop'>;

/** What the ledger reads and writes beyond the state it folds, handed in as `RoomSources` are. */
interface LedgerSources {
  /** The realm, where one is loaded; without it no counter can be caught selling the unlisted. */
  world: StockWorld | undefined;
  /** Told when a counter sells what the realm data does not list it stocking. */
  onDiscovery: ((discovery: Discovery) => void) | undefined;
  /** The pack's pending changes (`CharacterTracker.notePack`): what crossed the counter, and on which line. */
  notePack(seq: number, item: string, gained: boolean, count: number): void;
  /** Where a balance is written; `CharacterTracker.useBelongings` swaps it. */
  belongings(): Pick<BelongingsSink, 'rememberBanks'>;
}

/**
 * The counter and the vault: a purchase, a sale, a shop's `list`, a bank's
 * `bank` and the deposits and withdrawals made while standing in it.
 *
 * Owns the one memory the ledger has — the vault the character is standing
 * in — and is handed what it may not own (`LedgerSources`): the realm's shop
 * stock, the discovery report, the pack's pending changes and the record the
 * balances are written to.
 */
export class Ledger {
  /**
   * The vault the character is standing in, as the last `bank` in this room
   * named it — and null everywhere else.
   *
   * This is what lets a deposit and a withdrawal *maintain* a balance instead
   * of leaving it stale, and it is the standing shape: a command establishes
   * the figure, and the sentences the server volunteers keep it true until the
   * next command restates it. `You deposit N copper farthings.` names no bank,
   * so on its own it can only be attributed by guessing at the room — which is
   * the guess this whole area refuses. `Your balance at Bank of Godfrey is:`
   * names one outright, and it was said *here*, so the next deposit is this
   * vault's.
   *
   * Cleared the moment the room changes (`roomChanged`), beside `shopListing`
   * and for the same reason: walk to the next town's bank without asking and
   * there is no vault to credit, which is absence rather than the wrong answer.
   */
  private vault: { shop: number | null; name: string } | null = null;

  constructor(private readonly sources: LedgerSources) {}

  /** A new session, the menu, a closed socket: standing in no bank until one answers. */
  forget(): void {
    this.vault = null;
  }

  /**
   * The character stands somewhere else (`apply()` says what counts as a
   * move). A quotation and a vault both belong to the room they were given
   * in, so both go.
   */
  roomChanged(s: CharacterState): CharacterState {
    this.vault = null;
    return s.shopListing !== null ? { ...s, shopListing: null } : s;
  }

  /**
   * Something bought in a shop the realm data has stock for.
   *
   * This is the shop half of the realm memory, and it is answerable
   * *without* a capture of the `list` output — which is what had blocked
   * it. The buying sentence is already parsed (`You just bought a lantern
   * for 4 copper farthings.`), the room already resolves, and the realm
   * data already says which shop the room holds and what it stocks. If the
   * shop just sold something the data does not list, the data is out of
   * date and that is worth writing down.
   *
   * It records and does not correct: nothing here edits the realm file, for
   * the same reason a learned exit is not fed to the pathfinder.
   */
  bought(
    s: CharacterState,
    g: Readonly<Record<string, string>>,
    seq: number
  ): CharacterState | null {
    const item = g['item'];
    if (!item) return null;
    this.noticeStock(s, item);
    const bought = figure(g['quantity']) ?? 1;
    this.sources.notePack(seq, item, true, bought);
    /*
     * And it is *carried* now. Buying and selling move an item between the
     * shop and the pack exactly as taking and dropping move it between the
     * floor and the pack, and the listing that seeds the pack is the same
     * `i` in both cases — so leaving these out meant a shop trip left the
     * Carrying card describing the character as it was before the trip.
     */
    /*
     * And the purse went down by exactly what the server quoted, up the coin
     * ladder: GreaterMUD quotes copper, MajorMUD any coin (todo 815). See
     * `spent` for a coin off the ladder.
     */
    const carried = withItem(s, item, bought) ?? s;
    if (g['price'] === undefined) return carried;
    return spent(carried, quotedInCopper(`${g['price']} ${g['coin'] ?? ''}`)) ?? carried;
  }

  /**
   * `list`, in a shop — the command the realm data exists to make
   * unnecessary, and the authority when somebody types it anyway.
   *
   * Every line is checked against what the realm says this shop stocks, so
   * a shop selling something the data has never heard of is written to the
   * character's record. This is the shop half of the memory as it was
   * originally asked for: *"in a known shop and does a list, and there is an
   * item that is unknown, add it."*
   *
   * Nothing else is done with it. The listing is the shop's own truth for
   * one moment, and the realm data is what the client plans against; a card
   * that showed one and labelled it the other would be the confident wrong
   * answer this project refuses everywhere else.
   */
  shopListed(
    s: CharacterState,
    rows: ReadonlyArray<Readonly<Record<string, string>>>,
    at: number
  ): CharacterState | null {
    for (const row of rows) this.noticeStock(s, row['item']);
    /*
     * Kept, as the counter said it. The realm file is the lead — the Shop
     * face already shows what the data says is sold here before anybody
     * asks — and the counter is the authority: its `(You can't use)` is a
     * judgment about *this* character that the file cannot hold, and its
     * price is in coin where the file's is in copper. Cleared when another
     * room completes (`roomChanged`): a quotation belongs to the shop it was
     * made in.
     */
    const items = rows
      .map((row) => ({
        name: row['item']?.trim() ?? '',
        quantity: figure(row['quantity']),
        price: row['price']?.trim() ?? '',
        note: row['note']?.trim() || null
      }))
      .filter((item) => item.name.length > 0 && item.price.length > 0);
    if (items.length === 0) return null;
    return { ...s, shopListing: { items, at } };
  }

  /** `You sold …`: out of the pack, into the shop's hands, and the purse up by what it paid. */
  sold(s: CharacterState, g: Readonly<Record<string, string>>, seq: number): CharacterState | null {
    const item = g['item'];
    if (!item) return null;
    /*
     * Sold, so no longer carried — and *not* on the floor: the shop has it.
     * That is the difference from a drop, and getting it wrong would put an
     * item in the room's list that nobody in the room can pick up.
     */
    const sold = figure(g['count']) ?? 1;
    this.sources.notePack(seq, item, false, sold);
    const kept = withoutItem(s, item, sold) ?? s;
    const paid = figure(g['price']);
    return paid === null ? kept : (withSpend(kept, paid) ?? kept);
  }

  /**
   * A banking round moves two figures in opposite directions, and the
   * sentence states only one of them.
   *
   *     [HP=334/KAI=27]:deposit 310335
   *     You deposit 310335 copper farthings.
   *     [HP=334/KAI=27]:You withdrew 310335 copper farthings.
   *
   * The purse half is unconditional: the amount is in the sentence and the
   * purse is this character's, whatever room it happened in.
   *
   * The **vault** half is the maintained-listing shape, and it is the shape
   * rather than a guess because of `vault`. The sentence names no bank; the
   * `bank` that answered *in this room* named one outright, and the room has
   * not changed since or `roomChanged` would have cleared it. So the figure
   * the bank stated is moved by the amount the server just said it moved,
   * which is arithmetic on two facts rather than an attribution of one fact
   * to a room that may not resolve. With no `bank` asked here, there is no
   * vault and the balance is left exactly as it was, stale and openly so —
   * which is what it was before this existed.
   *
   * Clamped at zero on the withdrawal side for the same reason `withSpend`
   * clamps: a balance that has gone negative is a reading that drifted, and
   * a negative vault on a card is a bug wearing a number.
   */
  banked(
    s: CharacterState,
    amount: number | null,
    withdrawal: boolean,
    at: number
  ): CharacterState | null {
    if (amount === null) return null;
    // Deposit: out of the purse, into the vault. Withdrawal: the reverse.
    const toPurse = withdrawal ? amount : -amount;
    const moved = withSpend(s, toPurse) ?? s;
    const banked = this.creditVault(moved, -toPurse, at);
    return banked === s ? null : banked;
  }

  /**
   * `bank`, standing in one. The vault states what it holds, and it is the
   * only authority for that figure — nothing else on the wire mentions it.
   *
   * Merged rather than assigned: this names one bank and is silent about
   * every other, so `withBankBalance` leaves the rest alone. See the field
   * for why the shop id is the key and the printed name only the fallback.
   */
  balanceStated(
    s: CharacterState,
    g: Readonly<Record<string, string>>,
    at: number
  ): CharacterState | null {
    const name = g['bank']?.trim();
    const copper = figure(g['copper']);
    if (!name || copper === null) return null;
    const shop = figure(g['shop']);
    const next = withBankBalance(s, { shop, name, copper, at });
    /*
     * And this is the room it was said in, so a deposit or a withdrawal
     * made here has an account to move. Cleared by `roomChanged` on the
     * first block that puts the character anywhere else.
     */
    this.vault = { shop, name };
    /*
     * Written down here rather than by whoever watches state change,
     * because this is the only block that produces a balance and the merged
     * list is already in hand. The same shape as the discovery report: a
     * fact reported, with the file handle somebody else's.
     */
    this.sources.belongings().rememberBanks(next.banks);
    return next;
  }

  /**
   * Reports a shop selling something the realm data does not list it as
   * stocking.
   *
   * Narrow, like every other discovery, and for the same reason — this writes
   * to a character's permanent record:
   *
   * - **The room has to be known**, and has to be a shop the realm has stock
   *   for. Against a shop the data says nothing about, "not listed" is not a
   *   finding; it is the absence of data, and every purchase would produce one.
   * - **Names are compared the way items are compared everywhere else**, so an
   *   article or an equipment slot cannot make a listed item look unlisted.
   */
  private noticeStock(state: CharacterState, item: string | undefined): void {
    const { world, onDiscovery } = this.sources;
    if (!onDiscovery || !world || !item) return;
    const { map, number: roomNumber } = state.room;
    if (map === null || roomNumber === null) return;

    const id = roomId(map, roomNumber);
    const here = world.byId(id);
    if (!here?.shop) return;
    const shop = world.shop(here.shop);
    // No stock recorded is not "stocks nothing": it is a shop the realm data
    // cannot speak for, and every purchase there would otherwise be a finding.
    if (!shop) return;
    if (shop.items.some((stocked) => sameItem(stocked.name, item))) return;

    onDiscovery({
      reason: 'unknown-stock',
      from: id,
      fromName: shop.name.length > 0 ? shop.name : here.name,
      command: item.trim(),
      to: null,
      name: item.trim(),
      exits: [],
      at: Date.now()
    });
  }

  /**
   * Moves the standing vault's balance by `copper`, and writes it down.
   *
   * Returns the state untouched when there is no vault (no `bank` has been
   * answered in this room) or when the vault is not one this character has a
   * figure for — the first is the ordinary case of banking without asking
   * first, and the second cannot happen while `vault` is only ever set from
   * the block that also records the balance, but is checked rather than
   * assumed because a `BankBalance` created here from nothing would be a
   * balance invented out of a single deposit.
   */
  private creditVault(s: CharacterState, copper: number, at: number): CharacterState {
    const standing = this.vault;
    if (standing === null || copper === 0) return s;
    const held = balanceOf({ id: standing.shop, name: standing.name }, s.banks);
    if (held === null) return s;
    const next = withBankBalance(s, {
      ...held,
      copper: Math.max(0, held.copper + copper),
      at
    });
    this.sources.belongings().rememberBanks(next.banks);
    return next;
  }
}
