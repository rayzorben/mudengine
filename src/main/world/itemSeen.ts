/**
 * Where this client has seen each item a lookup names: the floors
 * (`FloorBook`), the shops' last lists (`ShopBook`) and the searches
 * (`FindBook`) of the realm played, newest first. See `mudengine-world` ›
 * `parts/lore.md` › *What lies on a floor is kept per realm*.
 */
import { isCash, type Logged } from '../../shared/finds';
import type { FloorSeen } from '../../shared/floor';
import { sameItem } from '../../shared/items';
import type { Shelf } from '../../shared/shops';
import type { ItemSeen } from '../../shared/itemSeen';
import type { WorldItem } from '../../shared/world';

/** What the join reads of the realm; `WorldGraph` is one. */
export interface SeenWorld {
  itemIdNamed(name: string): number | null;
}

/** The three records, as their stores hand them out. */
export interface SeenRecords {
  floor: readonly FloorSeen[];
  shelves: readonly Shelf[];
  finds: readonly Logged[];
}

/**
 * Each item's sightings, by its row; an item seen nowhere has no key.
 *
 * A recorded name is the item when it is the same spelling, or when the
 * realm's index settles it to the item's row (a plural the index confirms,
 * `Catalogue.itemIdNamed`). Several rows sharing a name each get the same
 * sightings, since the wire never said which row was lying there.
 */
export function itemSeen(
  items: readonly Pick<WorldItem, 'id' | 'name'>[],
  records: SeenRecords,
  world: SeenWorld
): Record<number, ItemSeen[]> {
  const out: Record<number, ItemSeen[]> = {};
  if (items.length === 0) return out;
  // A record of thousands of rows repeats its names; each is matched once.
  const matched = new Map<string, number[]>();
  const idsFor = (name: string): number[] => {
    const kept = matched.get(name);
    if (kept !== undefined) return kept;
    const row = world.itemIdNamed(name);
    const ids = items
      .filter((item) => sameItem(name, item.name) || row === item.id)
      .map((item) => item.id);
    matched.set(name, ids);
    return ids;
  };
  const add = (name: string, seen: ItemSeen): void => {
    for (const id of idsFor(name)) (out[id] ??= []).push(seen);
  };

  for (const row of records.floor) {
    add(row.name, {
      where: 'floor',
      room: row.room,
      roomName: row.roomName,
      first: row.first,
      at: row.at
    });
  }
  for (const shelf of records.shelves) {
    for (const line of shelf.items) {
      add(line.name, {
        where: 'shop',
        room: shelf.room,
        roomName: shelf.shopName,
        at: shelf.at,
        price: line.price,
        quantity: line.quantity
      });
    }
  }
  for (const find of records.finds) {
    if (isCash(find)) continue;
    add(find.name, {
      where: 'search',
      room: find.room,
      roomName: find.roomName,
      at: find.at,
      seen: find.seen
    });
  }
  for (const seen of Object.values(out)) seen.sort((a, b) => b.at - a.at);
  return out;
}
