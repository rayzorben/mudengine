/**
 * Where every room of the flat region around a centre falls on the grid:
 * geometry only, with nothing decorated (todo 130).
 *
 * Breadth-first from the centre along the compass exits (`planeSteps`), so
 * the nearest room owns a square: the square next to you is always the room
 * next to you, however the search later folds back on itself. A taken square
 * is not overwritten, and the room that could not have it is counted in
 * `dropped`. There is no step limit: the largest flat region measured is
 * 6,488 cells (Paradigm), placed in under 10 ms. `world.mapCells` is only a
 * ceiling above that, counted in `dropped` if a realm ever reaches it.
 */
import { NO_EXTENT, type MapWindow } from '../../shared/map';
import type { RoomId, WorldRoom } from '../../shared/world';
import { tuning } from '../app/tuning';
import { planeSteps, type PlaneGraph } from './planeSteps';

/** One placed room and its cell, in cells east and south of the centre. */
export interface PlacedRoom {
  room: WorldRoom;
  gx: number;
  gy: number;
}

export interface FlatPlacement {
  centre: RoomId;
  /** In the order placed, nearest first; the centre is the first. */
  rooms: readonly PlacedRoom[];
  /** The cells the rooms span. */
  extent: MapWindow;
  /** Rooms reached and not placed: a taken square, or the ceiling. */
  dropped: number;
}

/** The flat region around `centre`, or null for a room the realm does not have. */
export function placeFlat(
  graph: PlaneGraph,
  centre: RoomId,
  ceiling = tuning().world.mapCells
): FlatPlacement | null {
  const start = graph.byId(centre);
  if (!start) return null;

  const taken = new Set<string>(['0,0']);
  const seen = new Set<RoomId>([centre]);
  const rooms: PlacedRoom[] = [{ room: start, gx: 0, gy: 0 }];
  const extent = { ...NO_EXTENT };
  let dropped = 0;

  // A queue read by index: the rooms list is the queue, in breadth-first order.
  for (let next = 0; next < rooms.length; next += 1) {
    const { room, gx, gy } = rooms[next]!;
    for (const { dx, dy, to, destination } of planeSteps(graph, room)) {
      if (seen.has(to)) continue;
      seen.add(to);
      const nx = gx + dx;
      const ny = gy + dy;
      const key = `${nx},${ny}`;
      // Someone nearer already owns this square; the link is still drawn
      // from this room's exit list.
      if (taken.has(key) || rooms.length >= ceiling) {
        dropped += 1;
        continue;
      }
      taken.add(key);
      rooms.push({ room: destination, gx: nx, gy: ny });
      if (nx < extent.minX) extent.minX = nx;
      if (nx > extent.maxX) extent.maxX = nx;
      if (ny < extent.minY) extent.minY = ny;
      if (ny > extent.maxY) extent.maxY = ny;
    }
  }

  return { centre, rooms, extent, dropped };
}
