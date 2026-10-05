/**
 * What each shop's counter said the last time anybody typed `list` in it, kept
 * per realm. See `mudengine-world` › `parts/lore.md` › *A shop's list is kept
 * per realm*.
 */
import type { ShopListedItem } from './character';
import { quotedInCopper } from './coins';
import type { RoomId } from './world';

export const SHOPS_VERSION = 1;

/**
 * One shop's whole `list`, as its counter printed it.
 *
 * Keyed by the room it was listed in: a room the realm records no shop for can
 * still answer `list`, and the realm's shop id is kept beside it where there is
 * one. A later `list` in the same room replaces the shelf whole, because the
 * counter's listing is the whole shelf and a line it stopped printing is sold.
 */
export interface Shelf {
  room: RoomId;
  /** The realm's name for the shop, else the room's, so a row reads without the database. */
  shopName: string;
  /** The realm's shop id, or null where the realm records no shop in the room. */
  shop: number | null;
  /**
   * The character that typed `list`. Its prices are that character's (charm
   * moves them) and its `You can't use` notes are about that character.
   */
  by: string | null;
  /** When the counter answered. */
  at: number;
  items: ShopListedItem[];
}

/** The port a session writes a listing through; `ShopBook` is the store. */
export interface RealmShops {
  /** Replaces the shelf in `shelf.room` with this listing. */
  stock(shelf: Shelf): void;
  readonly all: readonly Shelf[];
}

export const NO_SHOPS: RealmShops = {
  stock: () => undefined,
  all: []
};

/** One line of one shelf, for a table that lists every shop's lines together. */
export interface ShelfLine {
  item: ShopListedItem;
  shelf: Shelf;
  /** The quoted price in copper, for sorting only; null where the words are not a price. */
  copper: number | null;
}

/**
 * Every shelf's lines, by item and then cheapest first, so a search for one
 * item reads down from the best place to buy it. A price this client cannot
 * read sorts after the ones it can.
 */
export function shelfLines(shelves: readonly Shelf[]): ShelfLine[] {
  return shelves
    .flatMap((shelf) =>
      shelf.items.map((item) => ({ item, shelf, copper: quotedInCopper(item.price) }))
    )
    .sort(
      (a, b) =>
        a.item.name.localeCompare(b.item.name) ||
        (a.copper ?? Number.POSITIVE_INFINITY) - (b.copper ?? Number.POSITIVE_INFINITY) ||
        a.shelf.shopName.localeCompare(b.shelf.shopName)
    );
}
