/**
 * What the navigation engine reads of the realm (`PlanRealm`), built from the
 * world's own answers: one builder for every caller that plans.
 */
import { roomId, type BuyingPlace, type RoomId, type Route } from '../../../shared/world';
import type { RouteOptions, Traveller } from '../Router';
import type { PlanRealm, StopperPlace } from './plan';
import type { ItemSource } from './sources';
import { standing, type StandingRealm } from './standing';

/** The world's answers the engine reads. */
export interface PlanWorld extends StandingRealm {
  route(from: RoomId, to: RoomId, traveller: Traveller, options?: RouteOptions): Route;
  sweepTo(
    from: RoomId,
    rooms: ReadonlySet<RoomId>,
    traveller: Traveller
  ): ReadonlyMap<RoomId, { cost: number }>;
  itemSources(item: number): readonly ItemSource[];
  namedExitItems(): readonly number[];
  item(id: number): { name: string } | undefined;
  /** Every item that stops a room spell (`Catalogue.stoppersOf`), in the realm's order. */
  stoppersOf(spell: number): ReadonlyArray<{ id: number; name: string; uses?: number }>;
  /** The counters selling any of `items`, least off the way from `from` to `to` first. */
  stockingPlaces(
    items: readonly number[],
    from: RoomId,
    to: RoomId | null,
    traveller: Traveller
  ): Array<BuyingPlace & { item: number }>;
}

export function planRealmOf(world: PlanWorld): PlanRealm {
  return {
    route: (from, to, traveller, options) => world.route(from, to, traveller, options),
    sweep: (from, rooms, traveller) => world.sweepTo(from, rooms, traveller),
    sources: (item) => world.itemSources(item),
    standing: (room) => standing(world, room),
    roomName: (room) => world.byId(room)?.name ?? room,
    keysNamed: () => world.namedExitItems(),
    itemName: (item) => world.item(item)?.name.trim() || undefined,
    stopperPlace: (spell, from, steps, traveller) =>
      stopperPlace(world, spell, from, steps, traveller)
  };
}

/**
 * Which stopper a way buys for a room spell, and where (todo 20261021-1200-01,
 * the quest planner's `supplyFor` before it): of every item the realm says
 * stops the spell, the one whose counter is least off the way to the first
 * room casting it (`stockingPlaces`, the petrol-station price), since a
 * counter the way passes beyond the water prices at nothing and is no use in
 * it. Null where no counter stocks any of them.
 */
function stopperPlace(
  world: PlanWorld,
  spell: number,
  from: RoomId,
  steps: ReadonlyArray<{ to: RoomId; scatter?: unknown }>,
  traveller: Traveller
): StopperPlace | null {
  const stoppers = world.stoppersOf(spell);
  const casting = steps.find(
    (step) => step.scatter === undefined && world.byId(step.to)?.spell === spell
  );
  const to = casting?.to ?? steps.at(-1)?.to ?? from;
  const place = world.stockingPlaces(
    stoppers.map((item) => item.id),
    from,
    to,
    traveller
  )[0];
  const item = place === undefined ? undefined : stoppers.find((each) => each.id === place.item);
  if (place === undefined || item === undefined) return null;
  return {
    item: { id: item.id, name: item.name, spent: item.uses !== undefined && item.uses > 0 },
    room: roomId(place.map, place.room),
    shop: place.shop,
    detour: place.detour
  };
}
