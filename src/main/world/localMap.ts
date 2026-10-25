/**
 * The rooms around the character as the Map card draws them.
 *
 * The geometry is `flatPlacement.ts`: the whole flat region from the centre,
 * nearest room first, a taken square never overwritten. Up and down leave the
 * plane and are not placed; a room with a vertical exit is marked instead.
 * This module decorates the placed rooms (doors, shops, the ways off the
 * plane, a lair's odds), and only those inside the asked window, since the
 * decoration is what costs (todo 130).
 */
import {
  EMPTY_MAP,
  inWindow,
  type LocalMap,
  type MapAway,
  type MapCell,
  type MapObstacle,
  type MapWindow,
  type Vertical
} from '../../shared/map';
import type { PageMaps } from '../../shared/routeLegs';
import type { SurvivalLevel } from '../../shared/survival';
import { roomId, type Direction, type RoomId, type WorldRoom } from '../../shared/world';
import { describeObstacle, leverOpening } from './obstacle';
import { landsInOneRoom, offPlaneWays, type PlaneGraph } from './planeSteps';
import type { WorldGraph } from './WorldGraph';
import { placeFlat, type FlatPlacement } from './flatPlacement';

/**
 * Which way a room leaves the plane.
 *
 * A room with only a way down used to be drawn with an arrow pointing up, which
 * is a map stating the opposite of the truth — and plenty of rooms have both.
 */
function verticalOf(directions: Direction[]): Vertical {
  const up = directions.includes('u');
  const down = directions.includes('d');
  if (up && down) return 'both';
  if (up) return 'up';
  if (down) return 'down';
  return null;
}

/** A lair's level for the character the map is drawn for; null where it is not known. */
export type LairLevel = (room: WorldRoom) => SurvivalLevel | null;

/**
 * One room as the map draws it, at a grid cell: its exits, doors, ways off the
 * plane, place and lair. The Map card's window and the game view's plane both
 * build their cells here.
 */
/** What a map cell is built from: the rooms, the shops, the levers and the item names a door's words need. */
export type MapCellGraph = Pick<
  WorldGraph,
  'byId' | 'beyond' | 'shop' | 'portalsFrom' | 'leversFor' | 'item' | 'landingCount'
>;

/**
 * A room's cell with only what the realm row states: its name, exits and
 * kind. What the route preview cuts its pages by (`plainMapOf`), where
 * nothing is drawn.
 */
function plainCellOf(room: WorldRoom, gx: number, gy: number): MapCell {
  const directions = room.exits.map((exit) => exit.direction);
  return {
    id: roomId(room.map, room.room),
    name: room.name,
    gx,
    gy,
    exits: directions,
    vertical: verticalOf(directions),
    shop: room.shop !== undefined,
    lair: room.lair !== undefined
  };
}

export function mapCellOf(
  graph: MapCellGraph,
  room: WorldRoom,
  gx: number,
  gy: number,
  lairLevel: LairLevel = () => null
): MapCell {
  const cell = plainCellOf(room, gx, gy);
  const place = room.shop === undefined ? undefined : graph.shop(room.shop)?.kind;
  if (place !== undefined) cell.place = place;
  const odds = room.lair === undefined ? null : lairLevel(room);
  if (odds !== null) cell.lairOdds = odds;
  if (room.safe === true) cell.safe = true;

  // A door is a property of the passage, so it travels with the exit.
  const blocked: Partial<Record<Direction, MapObstacle>> = {};
  for (const exit of room.exits) {
    if (!exit.requirement) continue;
    // With the word that opens it, where the room holds one — the map is
    // where a player decides whether a door is worth walking to.
    blocked[exit.direction] = describeObstacle(
      exit.requirement,
      graph,
      leverOpening(graph, cell.id, exit.direction)
    );
  }
  if (Object.keys(blocked).length > 0) cell.blocked = blocked;

  /*
   * The ways out the plane cannot draw, each with where it lands. Up and
   * down come off the exit table; a teleport comes off the room's script,
   * which is why the graph is asked for it separately. A destination the
   * realm does not have is left out — a control leading to a room that
   * does not exist is worse than none — and the command is the exit's own
   * phrase where it states one, because the bare direction does not work
   * on a `Text:` exit.
   */
  const away: MapAway[] = [];
  // One mark per landing room. The first way to it is kept: a room's
  // commands come before its spell and its item landings (`linkPortals`),
  // and a command's mark carries no obstacle. A press routes to the room,
  // and the route takes whichever way gets there.
  const landings = new Set<RoomId>();
  for (const way of offPlaneWays(graph, room)) {
    const { kind, to, destination } = way;
    if (way.kind === 'teleport') {
      // A roll among landings has no one room for a press to route to.
      if (!landsInOneRoom(way) || landings.has(to)) continue;
      landings.add(to);
      const { requirement } = way.exit;
      away.push({
        kind,
        to,
        name: destination.name,
        command: requirement.commands?.[0] ?? requirement.raw,
        // An unguarded portal's requirement is only its phrase — the command
        // above says that — so it is an obstacle only when it wants something.
        ...(requirement.kind !== 'text' ? { obstacle: describeObstacle(requirement, graph) } : {})
      });
      continue;
    }
    const { direction, requirement } = way.exit;
    away.push({
      kind,
      to,
      name: destination.name,
      command: requirement?.commands?.[0] ?? direction,
      ...(requirement
        ? {
            obstacle: describeObstacle(requirement, graph, leverOpening(graph, cell.id, direction))
          }
        : {})
    });
  }
  if (away.length > 0) cell.away = away;
  return cell;
}

/** The placement's cells inside `window`, decorated. */
export function decorate(
  graph: MapCellGraph,
  placement: FlatPlacement,
  window: MapWindow,
  lairLevel: LairLevel = () => null
): LocalMap {
  const cells: MapCell[] = [];
  for (const { room, gx, gy } of placement.rooms) {
    if (!inWindow(window, gx, gy)) continue;
    cells.push(mapCellOf(graph, room, gx, gy, lairLevel));
  }
  return {
    centre: placement.centre,
    cells,
    dropped: placement.dropped,
    placed: placement.rooms.length,
    extent: placement.extent
  };
}

/** Every placed room with only its plain cell: geometry, for cutting route pages. */
function plainMapOf(placement: FlatPlacement): LocalMap {
  return {
    centre: placement.centre,
    cells: placement.rooms.map(({ room, gx, gy }) => plainCellOf(room, gx, gy)),
    dropped: placement.dropped,
    placed: placement.rooms.length,
    extent: placement.extent
  };
}

/**
 * The maps a route's paging reads (`pagesOf`): each centre placed once for
 * the paging, its plain cells for the cut, and a sheet's floor decorated for
 * its crop only.
 */
export function pageMapsOf(graph: MapCellGraph & PlaneGraph, lairLevel: LairLevel): PageMaps {
  const placed = new Map<RoomId, FlatPlacement | null>();
  const placementOf = (centre: RoomId): FlatPlacement | null => {
    if (!placed.has(centre)) placed.set(centre, placeFlat(graph, centre));
    return placed.get(centre) ?? null;
  };
  return {
    placed: (centre) => {
      const placement = placementOf(centre);
      return placement === null ? EMPTY_MAP : plainMapOf(placement);
    },
    window: (centre, window) => {
      const placement = placementOf(centre);
      return placement === null ? EMPTY_MAP : decorate(graph, placement, window, lairLevel);
    }
  };
}
