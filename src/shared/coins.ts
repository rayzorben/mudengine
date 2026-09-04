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
import { DENOMINATIONS, type Denomination } from './character';
import type { CurrencyEntity } from './entities';

export const COPPER_PER: Readonly<Record<Denomination, number>> = {
  copper: 1,
  silver: 10,
  gold: 100,
  platinum: 10_000,
  runic: 1_000_000
};

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
  const word = match[2]!.toLowerCase();
  const denomination = DENOMINATIONS.find((name) => name === word);
  if (denomination === undefined || !Number.isFinite(amount)) return null;
  return amount * COPPER_PER[denomination];
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

/** The same, with one denomination added to what is already counted. */
export function addCoins(
  cash: CurrencyEntity | null,
  which: Denomination,
  count: number
): CurrencyEntity {
  const counts: Partial<Record<Denomination, number>> = {};
  for (const name of DENOMINATIONS) counts[name] = cash?.[name] ?? 0;
  counts[which] = (counts[which] ?? 0) + Math.max(0, Math.trunc(count));
  return currencyOf(counts);
}
