/**
 * Laying out the rooms around the character.
 *
 * Breadth-first from where they are standing, following horizontal exits and
 * assigning each room a grid cell. Nearest rooms are placed first, which is what
 * makes the result stable: the square next to you is always the room next to
 * you, however the search later folds back on itself.
 *
 * Two decisions worth stating, because both are places a map can start lying:
 *
 * - **Up and down leave the plane and are not placed.** A map that put them on
 *   it would draw two different rooms in one square and call it a floor plan.
 *   Rooms with a vertical exit are *marked* instead.
 * - **A taken cell is not overwritten.** A MUD is not Euclidean: two exits can
 *   lead to the same place and a corridor can bend back over itself. The room
 *   that got there first — the nearer one — keeps the square, and the count of
 *   what could not be placed is reported rather than hidden.
 */
import {
  type LocalMap,
  type MapAway,
  type MapCell,
  type MapObstacle,
  type Vertical
} from '../../shared/map';
import type { SurvivalLevel } from '../../shared/survival';
import { roomId, type Direction, type RoomId, type WorldRoom } from '../../shared/world';
import { describeObstacle, leverOpening } from './obstacle';
import { offPlaneWays, planeSteps } from './planeSteps';
import type { WorldGraph } from './WorldGraph';
import { tuning } from '../app/tuning';

/** Rooms out from the centre. Beyond this a rail-sized card cannot show it. */
export const DEFAULT_RADIUS = 5;

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

export function mapCellOf(
  graph: MapCellGraph,
  room: WorldRoom,
  gx: number,
  gy: number,
  lairLevel: LairLevel = () => null
): MapCell {
  const cell: MapCell = {
    id: roomId(room.map, room.room),
    name: room.name,
    gx,
    gy,
    exits: room.exits.map((exit) => exit.direction),
    vertical: verticalOf(room.exits.map((exit) => exit.direction)),
    shop: room.shop !== undefined,
    lair: room.lair !== undefined
  };
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
  for (const way of offPlaneWays(graph, room)) {
    const { kind, to, destination } = way;
    if (way.kind === 'teleport') {
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

export function localMap(
  graph: WorldGraph,
  centre: RoomId,
  radius = DEFAULT_RADIUS,
  lairLevel: LairLevel = () => null
): LocalMap {
  const start = graph.byId(centre);
  if (!start) return { centre: null, cells: [], dropped: 0 };

  const placed = new Map<string, MapCell>();
  const seen = new Set<RoomId>([centre]);
  let dropped = 0;

  const cellOf = (gx: number, gy: number): string => `${gx},${gy}`;

  const push = (room: WorldRoom, gx: number, gy: number): void => {
    placed.set(cellOf(gx, gy), mapCellOf(graph, room, gx, gy, lairLevel));
  };

  push(start, 0, 0);

  // Breadth-first, so distance from the centre decides who owns a square.
  let frontier: Array<{ room: WorldRoom; gx: number; gy: number }> = [
    { room: start, gx: 0, gy: 0 }
  ];

  for (let depth = 0; depth < radius && frontier.length > 0; depth += 1) {
    const next: typeof frontier = [];

    for (const { room, gx, gy } of frontier) {
      for (const { dx, dy, to: id, destination } of planeSteps(graph, room)) {
        if (seen.has(id)) continue;

        const nx = gx + dx;
        const ny = gy + dy;
        if (placed.has(cellOf(nx, ny))) {
          // Someone nearer already owns this square. The link is still real,
          // and still drawn from this room's exit list.
          dropped += 1;
          seen.add(id);
          continue;
        }
        if (placed.size >= tuning().world.mapCells) {
          dropped += 1;
          continue;
        }

        seen.add(id);
        push(destination, nx, ny);
        next.push({ room: destination, gx: nx, gy: ny });
      }
    }

    frontier = next;
  }

  return { centre, cells: [...placed.values()], dropped };
}
