/**
 * What the navigation engine reads of the realm (`PlanRealm`), built from the
 * world's own answers: one builder for every caller that plans.
 */
import type { RoomId, Route } from '../../../shared/world';
import type { RouteOptions, Traveller } from '../Router';
import type { PlanRealm } from './plan';
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
}

export function planRealmOf(world: PlanWorld): PlanRealm {
  return {
    route: (from, to, traveller, options) => world.route(from, to, traveller, options),
    sweep: (from, rooms, traveller) => world.sweepTo(from, rooms, traveller),
    sources: (item) => world.itemSources(item),
    standing: (room) => standing(world, room),
    roomName: (room) => world.byId(room)?.name ?? room
  };
}
