/**
 * The coin ladder, for comparing a quoted price to the purse.
 *
 * Measured, not assumed: `Wealth:` is a normalised total in copper, and eight
 * independent listings against their own totals put the rungs at
 * **1 / 10 / 100 / 10 000 / 1 000 000** — copper, silver, gold, platinum,
 * runic. Note the rungs are ×10, ×10, **×100, ×100**: an even ×10 ladder once
 * made platinum ten times and runic a hundred times too cheap.
 *
 *     51 gold, 7 copper                     ->     5 107   live (probe:play)
 *     12 platinum                           ->   120 000   captures/065
 *     94 platinum, 36 gold, 5 silver        ->   943 650   captures/087
 *     65 runic, 51 platinum, 118 gold       -> 65 521 800  captures/044
 *
 * The table came back for exactly one reason after being removed: a shop's
 * `list` quotes in coin (`20 gold crowns`) and the purse is known in copper
 * (`inventory.wealth`), and whether this character can pay is the question
 * a listing is read for. Nothing here converts for *display* — the counter's
 * words are shown as the counter said them, and this only answers "is that
 * more than I have".
 *
 * Only the first word of the noun is read (`gold` of `gold crowns`): the noun
 * is realm data, and captures/024's realm renames the runic coin outright. A
 * denomination this table does not name yields null — unknown, never zero.
 */
import { coinNamed, DENOMINATIONS, type Denomination } from './character';
import type { CurrencyEntity } from './entities';
import { escapeRegExp } from './regex';

export const COPPER_PER: Readonly<Record<Denomination, number>> = {
  copper: 1,
  silver: 10,
  gold: 100,
  platinum: 10_000,
  runic: 1_000_000
};

/**
 * A monster's coin maxima, one per denomination: `Monsters.R P G S C`, the
 * most of each it carries (realm format 49). Zero is none of that coin.
 */
export type CoinMaxima = Readonly<Record<Denomination, number>>;

/** Coin maxima read one coin at a time, so every reader spells the five coins once. */
export function coinMaximaOf(at: (coin: Denomination) => number): CoinMaxima {
  return Object.fromEntries(DENOMINATIONS.map((coin) => [coin, at(coin)])) as Record<
    Denomination,
    number
  >;
}

/**
 * The copper a kill is expected to carry, from its coin maxima.
 *
 * GreaterMUD rolls each coin on its own as the monster is made, 1 to its
 * maximum inclusive wherever the maximum is above none (`Mob.CreateCash`,
 * `Mob.cs:825`; `Randomizer.GetRandomNumber`, `Randomizer.cs:18`, is
 * `rand.Next(min, max + 1)`), so a coin's mean is `(1 + max) / 2`. A kobold
 * thief (S 7, C 20) is 4 silver and 10.5 copper: 50.5 copper.
 */
export function expectedCopper(maxima: CoinMaxima): number {
  return DENOMINATIONS.reduce(
    (sum, coin) => (maxima[coin] > 0 ? sum + ((1 + maxima[coin]) / 2) * COPPER_PER[coin] : sum),
    0
  );
}

/**
 * A quoted price in copper, or null where the words are not a price this
 * client can read. `Free` is zero — the one place a word is a number, because
 * the realm prints it for a starter shop and it means exactly that.
 */
export function quotedInCopper(quoted: string): number | null {
  const text = quoted.trim();
  if (/^free$/i.test(text)) return 0;
  const match = /^(\d[\d,]*)\s+([a-z]+)\b/i.exec(text);
  if (!match) return null;
  const amount = Number(match[1]!.replace(/,/g, ''));
  const denomination = coinNamed(match[2]!);
  if (denomination === undefined || !Number.isFinite(amount)) return null;
  return amount * COPPER_PER[denomination];
}

/**
 * A price said as a list of coins, each part up the ladder: MajorMUD's
 * training receipt, `1 gold crown, 5 silver nobles` (todo 745), handed over
 * already split. `nothing` is zero, as `Free` is. A part this client cannot
 * read makes the whole unknown rather than a smaller figure.
 */
export function coinsInCopper(parts: readonly string[]): number | null {
  if (parts.length === 1 && /^nothing$/i.test(parts[0]!.trim())) return 0;
  if (parts.length === 0) return null;
  let total = 0;
  for (const part of parts) {
    const copper = quotedInCopper(part);
    if (copper === null) return null;
    total += copper;
  }
  return total;
}

/**
 * `Items.Currency` read as the coin an item's `Price` is counted in — the
 * server's own table (`BuyCommand.GetCopperValue`, `ListCommand.GetCurrencyName`):
 * 0 copper, 1 silver, 2 gold, 3 platinum, 4 runic. Anything else is unknown.
 */
export function currencyOfCode(code: number): Denomination | null {
  return (['copper', 'silver', 'gold', 'platinum', 'runic'] as const)[code] ?? null;
}

/**
 * What a counter charges for one, in copper, before the buyer's charm —
 * `BuyCommand.TryToBuy`'s `markedUpCost`: the base in copper times
 * `(100 + markup)`, divided by 100 in integers. Measured against the wire: a
 * waterskin (25 silver) at the General Store (100%) was quoted 50 silver
 * nobles, and a short-spear (2 gold) sold for 400 copper (2026-09-03).
 */
export function counterPriceInCopper(
  price: number,
  currency: Denomination,
  markup: number
): number {
  return Math.trunc((COPPER_PER[currency] * price * (100 + markup)) / 100);
}

/**
 * What the buyer is charged for one: the counter's price less
 * `ceil(price × trunc((charm − 50) ÷ 5) ÷ 100)` — the server knocks a fifth of
 * a percent per point of charm over 50 off, and adds it under 50.
 *
 * An unread charm is priced at the sheet's floor (0: ten percent more), since
 * this answers *is the purse enough* and unknown is never the reassuring answer.
 */
export function chargedInCopper(counterPrice: number, charm: number | null): number {
  const modifier = Math.trunc(((charm ?? 0) - 50) / 5);
  return counterPrice - Math.ceil((counterPrice * modifier) / 100);
}

/**
 * A `CurrencyEntity` from counts by denomination, with the total the ladder
 * above produces.
 *
 * One place, because the arithmetic was written wherever coins were counted
 * and `totalCopper` is what every threshold compares. An unnamed denomination
 * is **zero** here, deliberately: a `CurrencyEntity` is only ever built from
 * something that enumerated the coins — a listing, a drop line, a vault
 * statement — and absence of the entity itself is how "nobody has said" is
 * expressed. That is unlike `Inventory.coins`, which keeps nulls precisely so
 * it can tell an unlisted denomination from an empty one.
 */
export function currencyOf(
  counts: Partial<Record<Denomination, number>>,
  rawText?: string
): CurrencyEntity {
  const at = (which: Denomination): number => Math.max(0, Math.trunc(counts[which] ?? 0));
  const entity: CurrencyEntity = {
    runic: at('runic'),
    platinum: at('platinum'),
    gold: at('gold'),
    silver: at('silver'),
    copper: at('copper'),
    totalCopper: 0
  };
  entity.totalCopper = DENOMINATIONS.reduce(
    (total, which) => total + entity[which] * COPPER_PER[which],
    0
  );
  if (rawText !== undefined) entity.rawText = rawText;
  return entity;
}

/**
 * A copper total broken back down the ladder, largest denomination first.
 *
 * The inverse of what `currencyOf` computes, and the one place this module
 * converts *for display* — which the header above says nothing else does, and
 * still does not: this exists because a record can hold a total where no
 * listing survives to be quoted. A find's cash is written down as copper, so
 * one number compares against every denomination the realm prints; showing it
 * as `1250 copper` would be arithmetic the reader has to undo.
 *
 * Greedy from the top, which is exact rather than approximate: the rungs are
 * whole multiples of each other, so every total has one spelling.
 */
export function copperSpread(copper: number): CurrencyEntity {
  let left = Math.max(0, Math.trunc(copper));
  const counts: Partial<Record<Denomination, number>> = {};
  for (const which of [...DENOMINATIONS].sort((a, b) => COPPER_PER[b] - COPPER_PER[a])) {
    const each = COPPER_PER[which];
    counts[which] = Math.floor(left / each);
    left -= counts[which] * each;
  }
  return currencyOf(counts);
}

/** The same, with one denomination added to what is already counted. */
export function addCoins(
  cash: CurrencyEntity | null,
  which: Denomination,
  count: number
): CurrencyEntity {
  return shifted(cash, which, Math.max(0, Math.trunc(count)));
}

/**
 * A count off one denomination, floored at none: coins picked up off the
 * floor (todo 746). A floor nothing has stated stays unstated.
 */
export function takeCoins(
  cash: CurrencyEntity | null,
  which: Denomination,
  count: number
): CurrencyEntity | null {
  return cash === null ? null : shifted(cash, which, -Math.max(0, Math.trunc(count)));
}

/** One denomination moved by `delta`; `currencyOf` floors every count at none. */
function shifted(cash: CurrencyEntity | null, which: Denomination, delta: number): CurrencyEntity {
  const counts: Partial<Record<Denomination, number>> = {};
  for (const name of DENOMINATIONS) counts[name] = cash?.[name] ?? 0;
  counts[which] = (counts[which] ?? 0) + delta;
  return currencyOf(counts);
}

/**
 * Each coin's own name as the stock server prints it (`MoneyContainer.cs`),
 * singular: the phrase a realm's renamed coin is read back to.
 */
export const STOCK_COIN: Readonly<Record<Denomination, string>> = {
  runic: 'runic coin',
  platinum: 'platinum piece',
  gold: 'gold crown',
  silver: 'silver noble',
  copper: 'copper farthing'
};

/**
 * A realm's own words for the coins it renamed, singular, by denomination
 * (`coins: { runic: dime bag }`, captures/024). A coin it does not name keeps
 * the stock name; nothing is guessed (todo 830).
 */
export type CoinNames = Partial<Record<Denomination, string>>;

/** A `coins:` block as the file states it: a word per coin it names, lower-cased; anything else dropped. */
export function asCoinNames(value: unknown): CoinNames {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const names: CoinNames = {};
  for (const coin of DENOMINATIONS) {
    const word = record[coin];
    if (typeof word === 'string' && word.trim().length > 0) names[coin] = word.trim().toLowerCase();
  }
  return names;
}

/** A realm's coin names in both directions. See `coinReader`. */
export interface CoinReader {
  /** The line with each renamed coin read back to its stock name, plural kept. */
  toStock(line: string): string;
  /** The word that picks a coin up here: the first of the realm's name, else the denomination. */
  word(coin: Denomination): string;
}

/**
 * Built once per realm's `coins:`, so the one pattern is compiled once
 * (`compiled-patterns.test.ts`). Only a name after a count is read, as every
 * coin sentence prints one (`4 dime bags`), so `crown of thorns` stays itself
 * on a realm that calls gold a crown; longest name first, so `dime bag` wins
 * over `dime`. The plural is the name plus `s` (captures/024), unmeasured for
 * any other. A realm that renames nothing reads every line as it came.
 */
export function coinReader(names: CoinNames): CoinReader {
  const renamed = DENOMINATIONS.filter((coin) => names[coin] !== undefined).sort(
    (a, b) => names[b]!.length - names[a]!.length
  );
  const stockOf = new Map(renamed.map((coin) => [names[coin]!, STOCK_COIN[coin]]));
  const pattern =
    renamed.length === 0
      ? null
      : new RegExp(
          `\\b(\\d+ )(${renamed.map((coin) => escapeRegExp(names[coin]!)).join('|')})(s?)\\b`,
          'gi'
        );
  return {
    toStock: (line) =>
      pattern === null
        ? line
        : line.replace(
            pattern,
            (_match, count: string, name: string, plural: string) =>
              `${count}${stockOf.get(name.toLowerCase()) ?? name}${plural}`
          ),
    word: (coin) => names[coin]?.split(/\s+/)[0] ?? coin
  };
}

/** Every bank on record, in copper. */
export function bankedCopper(banks: ReadonlyArray<{ copper: number }>): number {
  return banks.reduce((sum, bank) => sum + bank.copper, 0);
}
