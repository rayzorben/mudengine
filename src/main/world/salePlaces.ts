/**
 * The counters that buy an `Items` row and what one sale there pays: every
 * counter whose shelf lists the row, since `SellCommand` takes only the item
 * types its shop lists, a recycler's included, nearest first. The copper is
 * the server's arithmetic (`soldForCopper`) on the row's price, so every
 * counter pays the same and only the walk differs.
 */
import { soldForCopper } from '../../shared/coins';
import type { SalePlace } from '../../shared/selling';
import type { RoomId } from '../../shared/world';
import type { Traveller, WorldGraph } from './WorldGraph';

export type SaleWorld = Pick<WorldGraph, 'item' | 'stockingPlaces'>;

/** Where the row sells from `here`, nearest first; none where the realm states no price for it. */
export function salePlaces(
  item: number,
  charm: number | null,
  world: SaleWorld,
  here: RoomId,
  traveller: Traveller
): SalePlace[] {
  const row = world.item(item);
  if (row?.price === undefined || row.currency === undefined) return [];
  const copper = soldForCopper(row.price, row.currency, charm);
  return world
    .stockingPlaces([item], here, null, traveller, true)
    .map((place) => ({
      shop: place.shop,
      at: { map: place.map, room: place.room },
      roomName: place.roomName,
      moves: place.moves,
      copper
    }))
    .sort((a, b) => a.moves - b.moves);
}
