/**
 * What buying a light before the dark (`LightAhead`, todo 11) is handed: the
 * realm's lights, the counters ranked by detour as the item trip ranks them,
 * one lap's steps as its legs are planned, and the item trip that buys and
 * walks on. Out of `SessionManager`'s constructor whole, so the session
 * composes it in one call.
 */
import type { ItemErrand } from '../automation/ItemErrand';
import type { LightPlanner } from '../automation/LightAhead';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { WorldGraph } from '../world/WorldGraph';
import { realmLights } from '../../shared/lightPlan';
import { nextStop, splitStop } from '../../shared/loops';
import { roomAddress, type RoomId, type RouteStep } from '../../shared/world';
import type { Errands } from './Errands';

/** The modules, read when a walk asks: several are built after it. */
export interface LightPlannerModules {
  tracker: Pick<CharacterTracker, 'current'>;
  errands: Pick<Errands, 'travellerNow' | 'routeBetween' | 'stopRoom'>;
  itemErrand: Pick<ItemErrand, 'collect' | 'running'>;
  world: Pick<WorldGraph, 'itemsOfKind' | 'stockingPlaces'> | undefined;
}

export function lightPlanner(modules: () => LightPlannerModules): LightPlanner {
  return {
    lights: () => realmLights(modules().world?.itemsOfKind('light') ?? []),
    counters: (items, to) => {
      const { world, tracker, errands } = modules();
      const state = tracker.current;
      const here = roomAddress(state.room);
      if (world === undefined || here === null) return [];
      // The traveller the item trip prices its counters with (`Errands.itemSources`).
      return world.stockingPlaces(items, here, to, errands.travellerNow(state));
    },
    lapSteps: (loop) => {
      const { errands } = modules();
      const rooms = loop.stops.map((stop) => errands.stopRoom(splitStop(stop)));
      if (rooms.length < 2) return [];
      // One lap in the order the runner walks it (`nextStop`), round or there
      // and back, until it is back at the first stop going forward.
      const legs: Array<[RoomId | null, RoomId | null]> = [];
      let at = { index: 0, forward: true };
      do {
        const next = nextStop(loop, at.index, at.forward);
        legs.push([rooms[at.index] ?? null, rooms[next.index] ?? null]);
        at = next;
      } while (at.index !== 0 && legs.length < rooms.length * 2);
      // A stop or a leg that will not plan is the lap's own to report as it walks.
      return legs.flatMap(([from, to]): RouteStep[] => {
        if (from === null || to === null || from === to) return [];
        const route = errands.routeBetween(from, to, true);
        return typeof route === 'string' || route.blocked ? [] : route.steps;
      });
    },
    collect: (items, owes, run) => {
      const { itemErrand, tracker } = modules();
      return itemErrand.collect(items, owes, tracker.current, run);
    },
    collecting: () => modules().itemErrand.running
  };
}
