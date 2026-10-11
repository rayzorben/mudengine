/**
 * The counter a supply row naming no shop is bought at (todo 49): the nearest
 * that sells the item, ranked by `WorldGraph.stockingPlaces` as the light and
 * item trips rank theirs, passing over counters this session found without
 * it. A row no counter sells is found or nowhere by whether a monster drops
 * it. See `mudengine-automation` › `parts/errands.md` › *The pack is kept
 * stocked*.
 */
import { t } from '../app/i18n';
import type { SupplyCounter } from '../../shared/supplies';
import { roomId, type RoomId } from '../../shared/world';
import type { Traveller, WorldGraph } from '../world/WorldGraph';

export type CounterWorld = Pick<WorldGraph, 'itemIdNamed' | 'sourcesOf' | 'stockingPlaces'>;

export function nearestCounter(
  world: CounterWorld,
  item: string,
  here: RoomId | null,
  /** Asked only when a counter sells it: a found or nowhere row is answered on every statline. */
  traveller: () => Traveller,
  passOver: ReadonlySet<RoomId>
): SupplyCounter {
  const id = world.itemIdNamed(item);
  // Absent or shared: the row may still be filled off the floor, but which
  // counter sells it is not something the realm can say.
  if (id === null) return { kind: 'nowhere', why: t('session.supplies.noSingleRow', { item }) };
  const sources = world.sourcesOf({ id });
  if (sources.shops.length === 0) {
    return sources.mobs.length > 0
      ? { kind: 'found' }
      : { kind: 'nowhere', why: t('session.supplies.soldNowhere', { item }) };
  }
  if (here === null) return { kind: 'refused', why: t('session.supplies.notPlaced') };
  const places = world.stockingPlaces([id], here, null, traveller());
  const place = places.find((each) => !passOver.has(roomId(each.map, each.room)));
  if (place === undefined) {
    // Every counter reached was tried and did not list it: say that, not that none is reached.
    const why =
      places.length > 0
        ? t('session.supplies.noOtherCounter', { item })
        : t('session.supplies.noCounterReached', { item });
    return { kind: 'refused', why };
  }
  const room = roomId(place.map, place.room);
  return { kind: 'counter', room, name: place.shop, moves: place.moves };
}
