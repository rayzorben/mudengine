/**
 * The realm's stock and the counter's listing, as one table.
 *
 * The relationship is the one the Shop face's footnote has always stated: the
 * realm file is the **lead** — it says what is sold here before anybody asks —
 * and the counter is the **authority**. Where both name a thing, the counter's
 * price and note win; a thing the counter listed that the file does not know
 * is added; a thing the file names that the counter did not list is kept and
 * marked, because "not listed" is a fact about *today* that the file cannot
 * hold, and it is the fact that decides whether to walk in.
 *
 * Matching is by name, case-insensitively, and by nothing cleverer: the two
 * sources are written by different parts of the server and agree on names.
 */
import { quotedInCopper } from '@shared/coins';
import type { ShopListing } from '@shared/character';
import type { WorldShop } from '@shared/world';

export interface StockRow {
  name: string;
  /** The realm's item id, for a row the realm data has; null for a counter-only row. */
  id: number | null;
  /**
   * The realm file's own price figure, when it states one — `Items.Price`,
   * taken raw at build time. **Not copper**, and not the counter's unit: the
   * shipped data says `10` for a shortbow the counter sells for `20 gold
   * crowns` (2,000 copper) and `37` for a longbow it sells for `20 platinum
   * pieces` (200,000). What multiplies one into the other is unmeasured, so
   * the two are never compared, sorted together, or shown as the same number.
   */
  realmPrice: number | null;
  /** The counter's words, verbatim, when it listed this. */
  quoted: string | null;
  /** The counter's price in copper, for sorting and for the purse; null when unreadable. */
  quotedCopper: number | null;
  /** How many the counter said were on the shelf. */
  quantity: number | null;
  /** The counter's judgment, `You can't use`, or null. */
  note: string | null;
  /**
   * Whether the counter listed it. Null when no listing has been taken here
   * at all — an unasked counter has not said no — so a row is marked "not
   * listed" only against a listing that exists.
   */
  listed: boolean | null;
}

const key = (name: string): string => name.trim().toLowerCase();

export function mergeStock(shop: WorldShop | null, listing: ShopListing | null): StockRow[] {
  const quoted = new Map(listing?.items.map((item) => [key(item.name), item]) ?? []);
  const rows: StockRow[] = [];
  const seen = new Set<string>();

  for (const item of shop?.items ?? []) {
    const said = quoted.get(key(item.name));
    seen.add(key(item.name));
    rows.push({
      name: item.name,
      id: item.id,
      realmPrice: item.price ?? null,
      quoted: said?.price ?? null,
      quotedCopper: said ? quotedInCopper(said.price) : null,
      quantity: said?.quantity ?? null,
      note: said?.note ?? null,
      listed: listing === null ? null : said !== undefined
    });
  }
  for (const item of listing?.items ?? []) {
    if (seen.has(key(item.name))) continue;
    seen.add(key(item.name));
    rows.push({
      name: item.name,
      id: null,
      realmPrice: null,
      quoted: item.price,
      quotedCopper: quotedInCopper(item.price),
      quantity: item.quantity,
      note: item.note,
      listed: true
    });
  }
  return rows;
}

/**
 * What the price column sorts and searches by: one unit per table.
 *
 * With a listing, the counter's copper — and a row the counter did not quote
 * is null, which the table sorts last whichever way the column points, the
 * same as any value the realm does not have. Without one, the file's own
 * figure, which is at least the same unit down the whole column. Mixing the
 * two put every unlisted row above every quoted one when sorted by price,
 * because `10` is less than `2000` whatever the units.
 */
export function priceValue(row: StockRow, listing: ShopListing | null): number | null {
  return listing === null ? row.realmPrice : row.quotedCopper;
}

/**
 * Whether the purse covers the counter's price. Null is *cannot say*: no
 * quotation, an unreadable one, or a purse nobody has counted — never a
 * reassuring yes. The purse is `Wealth:` as last listed; a coin picked up
 * since counts up its own denomination and not this figure, so the caller
 * says so beside a negative.
 */
export function affordable(row: StockRow, wealth: number | null): boolean | null {
  if (row.quotedCopper === null || wealth === null) return null;
  return row.quotedCopper <= wealth;
}
