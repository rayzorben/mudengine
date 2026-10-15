/**
 * Every room of one map on one plane, for the game view (todo 140).
 *
 * Breadth-first over `planeSteps` from either end of an exit, nothing
 * dropped: a room whose cell is taken starts an island pushed out along the
 * exit that reached it. Up, down and a room's teleport (`leapSteps`) start an
 * island beside the room they leave; a room nothing on the map reaches starts
 * one `UNJOINED_GAP` east of everything. Laid out on first ask and kept
 * (Paradigm's 57,511 rooms in 0.2 s). The reasons are in `mudengine-world`
 * › `parts/realm.md` › *The game view's map*.
 */
import { cellKey } from '../../shared/gameMap';
import { roomId, type RoomId, type WorldRoom } from '../../shared/world';
import { leapSteps, planeSteps, type LeapGraph, type PlaneLink } from './planeSteps';

export interface PlaneLayout {
  readonly map: number;
  /** Where each room of the map sits. */
  readonly at: ReadonlyMap<RoomId, { gx: number; gy: number }>;
  /** Which room sits in a cell, by `cellKey`. */
  readonly cells: ReadonlyMap<string, RoomId>;
  /** Which island each room belongs to; a stretch label never crosses one. */
  readonly island: ReadonlyMap<RoomId, number>;
}

/**
 * Cells of air between islands no way on the map joins, so one never reads as
 * part of the area beside it (three cells did: a ganghouse's Rubbish Disposal
 * Chamber stood at the Crimson Fortress's door).
 */
export const UNJOINED_GAP = 10;

interface Spill {
  room: WorldRoom;
  /** The placed room whose exit could not take its cell, or whose way leaves the plane. */
  from: RoomId;
  dx: number;
  dy: number;
}

/** Each room's ways to other rooms of the map, its own first, then the ones that lead in. */
function linksOf(
  graph: LeapGraph,
  map: number,
  rooms: readonly WorldRoom[],
  ways: (graph: LeapGraph, room: WorldRoom) => Iterable<PlaneLink>
): Map<RoomId, PlaneLink[]> {
  const links = new Map<RoomId, PlaneLink[]>();
  const add = (id: RoomId, link: PlaneLink) => {
    const held = links.get(id);
    if (held) held.push(link);
    else links.set(id, [link]);
  };
  const inward: Array<[RoomId, PlaneLink]> = [];
  for (const room of rooms) {
    const id = roomId(room.map, room.room);
    for (const { dx, dy, to, destination } of ways(graph, room)) {
      if (destination.map !== map) continue;
      add(id, { dx, dy, to, destination });
      inward.push([to, { dx: -dx, dy: -dy, to: id, destination: room }]);
    }
  }
  for (const [id, link] of inward) add(id, link);
  return links;
}

export function layOutMap(graph: LeapGraph, map: number, rooms: readonly WorldRoom[]): PlaneLayout {
  const steps = linksOf(graph, map, rooms, planeSteps);
  const leaps = linksOf(graph, map, rooms, leapSteps);
  const at = new Map<RoomId, { gx: number; gy: number }>();
  const cells = new Map<string, RoomId>();
  const island = new Map<RoomId, number>();
  let islands = 0;
  let east = 0;

  /** One island from a seed, in its own coordinates, and the rooms it could not place. */
  const grow = (
    seed: WorldRoom
  ): { local: Map<RoomId, { gx: number; gy: number }>; spill: Spill[] } => {
    const seedId = roomId(seed.map, seed.room);
    const local = new Map([[seedId, { gx: 0, gy: 0 }]]);
    const taken = new Set([cellKey(0, 0)]);
    const spill: Spill[] = [];
    const queue: WorldRoom[] = [seed];
    for (let head = 0; head < queue.length; head += 1) {
      const room = queue[head]!;
      const id = roomId(room.map, room.room);
      const here = local.get(id)!;
      for (const { dx, dy, to, destination } of steps.get(id) ?? []) {
        if (local.has(to) || at.has(to)) continue;
        const key = cellKey(here.gx + dx, here.gy + dy);
        if (taken.has(key)) {
          spill.push({ room: destination, from: id, dx, dy });
          continue;
        }
        local.set(to, { gx: here.gx + dx, gy: here.gy + dy });
        taken.add(key);
        queue.push(destination);
      }
    }
    // The ways off the plane, once the island's own rooms are all placed.
    for (const room of queue) {
      const id = roomId(room.map, room.room);
      for (const { dx, dy, to, destination } of leaps.get(id) ?? [])
        if (!local.has(to) && !at.has(to)) spill.push({ room: destination, from: id, dx, dy });
    }
    return { local, spill };
  };

  const clear = (local: Map<RoomId, { gx: number; gy: number }>, ox: number, oy: number) => {
    for (const { gx, gy } of local.values())
      for (let dx = -1; dx <= 1; dx += 1)
        for (let dy = -1; dy <= 1; dy += 1)
          if (cells.has(cellKey(gx + ox + dx, gy + oy + dy))) return false;
    return true;
  };

  const commit = (local: Map<RoomId, { gx: number; gy: number }>, ox: number, oy: number) => {
    for (const [id, { gx, gy }] of local) {
      const placed = { gx: gx + ox, gy: gy + oy };
      at.set(id, placed);
      cells.set(cellKey(placed.gx, placed.gy), id);
      island.set(id, islands);
      east = Math.max(east, placed.gx);
    }
    islands += 1;
  };

  const ordered = [...rooms].sort((a, b) => a.room - b.room);
  for (const root of ordered) {
    if (at.has(roomId(root.map, root.room))) continue;
    const pending: Array<Spill | { room: WorldRoom; from: null }> = [{ room: root, from: null }];
    for (let head = 0; head < pending.length; head += 1) {
      const next = pending[head]!;
      if (at.has(roomId(next.room.map, next.room.room))) continue;
      const { local, spill } = grow(next.room);
      let ox: number;
      let oy: number;
      if (next.from === null) {
        ox =
          at.size === 0
            ? 0
            : east + UNJOINED_GAP - Math.min(...[...local.values()].map((cell) => cell.gx));
        oy = 0;
      } else {
        const parent = at.get(next.from)!;
        let reach = 2;
        do {
          ox = parent.gx + next.dx * reach;
          oy = parent.gy + next.dy * reach;
          reach += 1;
        } while (!clear(local, ox, oy));
      }
      commit(local, ox, oy);
      pending.push(...spill);
    }
  }
  return { map, at, cells, island };
}

/** Each map's plane, laid out the first time it is asked for and kept. */
export class RealmLayouts {
  private readonly planes = new Map<number, PlaneLayout>();
  private byMap: Map<number, WorldRoom[]> | null = null;

  constructor(private readonly graph: LeapGraph & { everyRoom(): Iterable<WorldRoom> }) {}

  /** Every room of a map, read from the graph once. */
  roomsOf(map: number): readonly WorldRoom[] {
    if (this.byMap === null) {
      this.byMap = new Map();
      for (const room of this.graph.everyRoom()) {
        const list = this.byMap.get(room.map);
        if (list) list.push(room);
        else this.byMap.set(room.map, [room]);
      }
    }
    return this.byMap.get(map) ?? [];
  }

  of(map: number): PlaneLayout {
    const kept = this.planes.get(map);
    if (kept) return kept;
    const plane = layOutMap(this.graph, map, this.roomsOf(map));
    this.planes.set(map, plane);
    return plane;
  }
}
