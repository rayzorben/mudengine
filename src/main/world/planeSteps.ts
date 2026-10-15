/**
 * The steps out of a room that a flat map can draw: each compass exit, with
 * the room it lands in. The one placing rule for the Map card's window
 * (`localMap`) and the game view's whole-map plane (`realmLayout`), which
 * also follows `leapSteps`, the ways the plane cannot draw.
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

/** A room one way out of another, and the cell offset it is drawn at. */
export interface PlaneLink {
  dx: number;
  dy: number;
  to: RoomId;
  destination: WorldRoom;
}

export interface PlaneStep extends PlaneLink {
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
 * teleports. The Map card's marks (`mapCellOf`) take every one; the game
 * view's plane (`leapSteps`) skips a cast that scatters, as `planeSteps` does.
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
 * Where the plane sets down a room reached by a way it cannot draw: up to the
 * north-east, down to the south-west, a room's teleport (`go path`) east. The
 * floor above then sits beside the stairs instead of wherever its room
 * numbers fall.
 */
const LEAP: Record<OffPlaneWay['kind'], { dx: number; dy: number }> = {
  up: { dx: 1, dy: -1 },
  down: { dx: -1, dy: 1 },
  teleport: { dx: 1, dy: 0 }
};

/** The ways off the plane the game view's layout follows, with where it sets each down. */
export function* leapSteps(
  graph: LeapGraph,
  room: WorldRoom
): Generator<PlaneLink & { way: OffPlaneWay }> {
  for (const way of offPlaneWays(graph, room)) {
    if (way.kind !== 'teleport' && way.exit.requirement?.spellEffect === 'scatters') continue;
    yield { ...LEAP[way.kind], to: way.to, destination: way.destination, way };
  }
}
