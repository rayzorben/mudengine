/**
 * What the quest planner reads of the rooms: the table and the passages the
 * router reads too, and the room joins the graph keeps because the router,
 * the Reference card and the errands ask them as well.
 *
 * Beneath both sides — `QuestPlanner` reads it, and `WorldGraph` composes it
 * from its own tables and joins (todo 712) — so the planner never imports the
 * graph. See `mudengine-world` › `parts/quests.md`.
 */
import type {
  BuyingPlace,
  MobPlaces,
  RoomId,
  ShopPlace,
  WorldItem,
  WorldMob,
  WorldRoom
} from '../../shared/world';
import type { RoomIndex } from './RoomIndex';
import type { Traveller } from './Router';

export interface PlannerRooms extends Pick<RoomIndex, 'roomsById' | 'corridorsOn'> {
  /** Where the realm spawns a monster, grouped by room name and capped. */
  mobPlaces(mob: WorldMob): MobPlaces | undefined;
  /** Every placement of a monster, uncapped: one entry per room and slot. */
  spawnRoomsOf(mob: WorldMob): ReadonlyArray<{ readonly room: WorldRoom }>;
  /** Where a shop of this name is: one room, or several reported as several. */
  shopPlace(name: string): ShopPlace | undefined;
  /** An item with each of its handovers' rooms named. */
  placingHandovers(item: WorldItem): WorldItem;
  /** Where to buy one thing on the way from `from` to `to`, best first. */
  buyingPlaces(item: number, from: RoomId, to: RoomId | null, traveller: Traveller): BuyingPlace[];
  /** The same for several things on one pair of sweeps, each place saying which. */
  stockingPlaces(
    items: readonly number[],
    from: RoomId,
    to: RoomId | null,
    traveller: Traveller
  ): Array<BuyingPlace & { item: number }>;
}
