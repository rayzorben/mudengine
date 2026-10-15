/**
 * The steps out of a room that a flat map can draw: each compass exit, with
 * the room it lands in. The one placing rule for the Map card's window
 * (`localMap`) and the game view's whole-map plane (`realmLayout`).
 *
 * A draw reaches no particular room, so an exit whose cast scatters is not a
 * step: drawing onwards from the room its table names would put a corridor on
 * the picture that nobody can walk, the reading `withinSteps` refuses.
 */
import { STEP } from '../../shared/map';
import type { RoomId, WorldExit, WorldRoom } from '../../shared/world';
import type { WorldGraph } from './WorldGraph';

export type PlaneGraph = Pick<WorldGraph, 'beyond' | 'byId'>;

export interface PlaneStep {
  exit: WorldExit;
  dx: number;
  dy: number;
  to: RoomId;
  destination: WorldRoom;
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
