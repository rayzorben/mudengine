/**
 * The steps out of a room that a flat map can draw: each compass exit, with
 * the room it lands in. The one placing rule for the Map card's window
 * (`localMap`) and the game view's floors (`realmLayout`), which also
 * follows `leapSteps`, the ways a flat floor cannot draw.
 *
 * A draw reaches no particular room, so an exit whose cast scatters is not a
 * step: drawing onwards from the room its table names would put a corridor on
 * the picture that nobody can walk, the reading `withinSteps` refuses.
 */
import { STEP } from '../../shared/map';
import { roomId, type RoomId, type WorldExit, type WorldRoom } from '../../shared/world';
import type { PortalExit } from './RoomIndex';
import type { WorldGraph } from './WorldGraph';

export type PlaneGraph = Pick<WorldGraph, 'beyond' | 'byId'>;

/** A room one compass exit out of another, and the cell offset it is drawn at. */
export interface PlaneStep {
  dx: number;
  dy: number;
  to: RoomId;
  destination: WorldRoom;
  exit: WorldExit;
}

export function* planeSteps(graph: PlaneGraph, room: WorldRoom): Generator<PlaneStep> {
  for (const exit of room.exits) {
    const step = STEP[exit.direction];
    // Vertical, or a direction the realm data uses that a plane does not draw.
    if (!step) continue;
    if (exit.requirement?.spellEffect === 'scatters') continue;
    const to = graph.beyond(exit);
    const destination = graph.byId(to);
    if (!destination) continue;
    yield { exit, dx: step.dx, dy: step.dy, to, destination };
  }
}

export type LeapGraph = PlaneGraph & Pick<WorldGraph, 'portalsFrom'>;

/** A way out of a room that leaves the plane, with the room it lands in. */
export type OffPlaneWay =
  | { kind: 'up' | 'down'; exit: WorldExit; to: RoomId; destination: WorldRoom }
  | { kind: 'teleport'; exit: PortalExit; to: RoomId; destination: WorldRoom };

/**
 * The ways out of a room the plane cannot draw: up, down and the room's
 * teleports. The Map card's marks (`mapCellOf`) take every one but a teleport
 * that does not land in one room; the game view's plane (`leapSteps`) also
 * skips a cast that scatters, as `planeSteps` does.
 */
export function* offPlaneWays(graph: LeapGraph, room: WorldRoom): Generator<OffPlaneWay> {
  for (const exit of room.exits) {
    if (exit.direction !== 'u' && exit.direction !== 'd') continue;
    // Where it goes, which for an exit whose cast teleports is the spell's
    // room and not the table's (`WorldGraph.beyond`).
    const to = graph.beyond(exit);
    const destination = graph.byId(to);
    if (!destination) continue;
    yield { kind: exit.direction === 'u' ? 'up' : 'down', exit, to, destination };
  }
  for (const portal of graph.portalsFrom(roomId(room.map, room.room))) {
    const to = roomId(portal.map, portal.room);
    const destination = graph.byId(to);
    if (!destination) continue;
    yield { kind: 'teleport', exit: portal, to, destination };
  }
}

/**
 * Whether a teleport lands in the one room it names: not a draw, and not one
 * landing of a roll among several (format 73). A room spell's roll is its
 * wait, one tick per try (`spellWays`), so only a line that always fires
 * lands in one room. Crystal Lake's drift has twenty landings per room.
 */
export function landsInOneRoom(way: Extract<OffPlaneWay, { kind: 'teleport' }>): boolean {
  const { requirement } = way.exit;
  if (requirement.spellEffect === 'scatters' || requirement.tries !== undefined) return false;
  return requirement.kind !== 'room-spell' || (requirement.waits?.ticks ?? 1) <= 1;
}

/**
 * The ways off the plane the game view's layout follows (`realmLayout`): up and
 * down change the floor, a teleport sets its landing beside the room. A
 * chance landing, a draw, a ship's passage and a monster's ask are left out
 * of the layout (format 73).
 */
export function* leapSteps(graph: LeapGraph, room: WorldRoom): Generator<OffPlaneWay> {
  for (const way of offPlaneWays(graph, room)) {
    const requirement = way.exit.requirement;
    if (way.kind !== 'teleport') {
      if (requirement?.spellEffect !== 'scatters') yield way;
    } else if (
      landsInOneRoom(way) &&
      requirement?.waits === undefined &&
      requirement?.asks === undefined
    ) {
      yield way;
    }
  }
}
