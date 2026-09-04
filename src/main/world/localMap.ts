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
  STEP,
  type LocalMap,
  type MapCell,
  type MapObstacle,
  type Vertical
} from '../../shared/map';
import { roomId, type Direction, type RoomId } from '../../shared/world';
import { describeObstacle } from './obstacle';
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

export function localMap(graph: WorldGraph, centre: RoomId, radius = DEFAULT_RADIUS): LocalMap {
  const start = graph.byId(centre);
  if (!start) return { centre: null, cells: [], dropped: 0 };

  const placed = new Map<string, MapCell>();
  const seen = new Set<RoomId>([centre]);
  let dropped = 0;

  const cellOf = (gx: number, gy: number): string => `${gx},${gy}`;

  const push = (room: typeof start, gx: number, gy: number): MapCell => {
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

    // A door is a property of the passage, so it travels with the exit.
    const blocked: Partial<Record<Direction, MapObstacle>> = {};
    for (const exit of room.exits) {
      if (!exit.requirement) continue;
      blocked[exit.direction] = describeObstacle(exit.requirement, graph);
    }
    if (Object.keys(blocked).length > 0) cell.blocked = blocked;

    placed.set(cellOf(gx, gy), cell);
    return cell;
  };

  push(start, 0, 0);

  // Breadth-first, so distance from the centre decides who owns a square.
  let frontier: Array<{ room: typeof start; gx: number; gy: number }> = [
    { room: start, gx: 0, gy: 0 }
  ];

  for (let depth = 0; depth < radius && frontier.length > 0; depth += 1) {
    const next: typeof frontier = [];

    for (const { room, gx, gy } of frontier) {
      for (const exit of room.exits) {
        const step = STEP[exit.direction as Direction];
        // Vertical, or a direction the realm data uses that we do not draw.
        if (!step) continue;

        const id = roomId(exit.map, exit.room);
        if (seen.has(id)) continue;

        const destination = graph.byId(id);
        if (!destination) continue;

        const nx = gx + step.dx;
        const ny = gy + step.dy;
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
