/**
 * The engine's breadth-first sweep: every room reached from one, nearest
 * first, with the fewest moves to each. What the router's neighbourhood
 * (`withinSteps`), a monster's nearest lair (`WorldGraph.resolveMobRow`) and a
 * timed passage's length (`WorldGraph.corridorFrom`) are each one set of rules
 * over, so no file outside the engine walks exits room by room
 * (`structure.test.ts` › *one navigation engine*). Prices nothing: a route
 * prices. `mudengine-world` › *There is one navigation engine*.
 */
import { roomId, type RoomId, type WorldExit, type WorldRoom } from '../../../shared/world';
import type { PortalExit } from '../RoomIndex';

/** What a sweep reads of the realm: the rooms, a room's teleports, and where an exit lands. */
export interface SweepRooms {
  readonly roomsById: ReadonlyMap<RoomId, WorldRoom>;
  portalsFrom(id: RoomId): readonly PortalExit[];
  beyond(exit: WorldExit | PortalExit): RoomId;
}

/** Which room an exit reaches: the exit table's, or where a character lands. */
export type Lands = 'table' | 'beyond';

export interface SweepRules {
  /**
   * Which room an exit reaches: the one the exit table names, or the one a
   * character lands in (`Router.beyond`, a teleporting cast's room). A portal
   * always reaches the room it names.
   */
  readonly lands: Lands;
  /** Whether a room script's teleports (`portalsFrom`) are ways out too. */
  readonly portals: boolean;
  /** Rooms this many moves out are reached and not walked out of. Unbounded when absent. */
  readonly steps?: number;
  /** Stops before the next ring once more rooms than this are reached. Unbounded when absent. */
  readonly rooms?: number;
  /** Whether to walk one way out of a room `steps` moves out; every way when absent. */
  readonly walks?: (way: WorldExit | PortalExit, steps: number) => boolean;
  /** Each room as the sweep comes to it, the start first; false stops the sweep there. */
  readonly visit?: (id: RoomId, steps: number) => boolean;
}

/**
 * Every room reached from `from` by `rules`, the start at 0, with the fewest
 * moves to each, in a map the caller owns. A room missing from the realm is
 * never reached: an exit into one is a hole in the data, not a way. Empty for
 * a start the realm does not hold.
 */
export function sweep(realm: SweepRooms, from: RoomId, rules: SweepRules): Map<RoomId, number> {
  const steps = new Map<RoomId, number>();
  if (!realm.roomsById.has(from)) return steps;
  steps.set(from, 0);
  let frontier: RoomId[] = [from];
  for (let ring = 0; frontier.length > 0; ring += 1) {
    if (rules.rooms !== undefined && steps.size > rules.rooms) break;
    const next: RoomId[] = [];
    for (const id of frontier) {
      if (rules.visit !== undefined && !rules.visit(id, ring)) return steps;
      if (rules.steps !== undefined && ring >= rules.steps) continue;
      for (const way of waysOut(realm, id, rules.portals)) {
        if (rules.walks !== undefined && !rules.walks(way, ring)) continue;
        const to = landing(realm, way, rules.lands);
        if (steps.has(to) || !realm.roomsById.has(to)) continue;
        steps.set(to, ring + 1);
        next.push(to);
      }
    }
    frontier = next;
  }
  return steps;
}

/** The room a way reaches by `lands`; a portal always reaches the room it names. */
function landing(realm: SweepRooms, way: WorldExit | PortalExit, lands: Lands): RoomId {
  if (way.direction === 'portal') return roomId(way.map, way.room);
  switch (lands) {
    case 'table':
      return roomId(way.map, way.room);
    case 'beyond':
      return realm.beyond(way);
    default: {
      const unhandled: never = lands;
      throw new Error(`unhandled landing rule ${String(unhandled)}`);
    }
  }
}

function waysOut(
  realm: SweepRooms,
  id: RoomId,
  portals: boolean
): ReadonlyArray<WorldExit | PortalExit> {
  const exits = realm.roomsById.get(id)?.exits ?? [];
  return portals ? [...exits, ...realm.portalsFrom(id)] : exits;
}
