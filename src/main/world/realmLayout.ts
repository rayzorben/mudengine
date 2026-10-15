/**
 * Every room of one map on one plane, for the game view (todo 140).
 *
 * Breadth-first over `planeSteps`, the Map card's placing rule, but nothing
 * is dropped: a room whose cell is taken starts an island of its own, laid
 * out the same way and then pushed out along the exit that reached it until
 * it overlaps nothing, with a cell of air around it. Only exits within the
 * map are followed; a way onto another map is a way off this plane. A room no
 * island reaches starts one to the east of everything placed.
 *
 * Laid out on first ask and kept (Paradigm's 57,511 rooms took 0.2 s in all,
 * measured with the prototype), so nothing ships coordinates and a converted
 * realm gets a plane too.
 */
import { cellKey } from '../../shared/gameMap';
import { roomId, type RoomId, type WorldRoom } from '../../shared/world';
import { planeSteps, type PlaneGraph } from './planeSteps';

export interface PlaneLayout {
  readonly map: number;
  /** Where each room of the map sits. */
  readonly at: ReadonlyMap<RoomId, { gx: number; gy: number }>;
  /** Which room sits in a cell, by `cellKey`. */
  readonly cells: ReadonlyMap<string, RoomId>;
  /** Which island each room belongs to; a stretch label never crosses one. */
  readonly island: ReadonlyMap<RoomId, number>;
}

interface Spill {
  room: WorldRoom;
  /** The placed room whose exit could not take its cell. */
  from: RoomId;
  dx: number;
  dy: number;
}

export function layOutMap(
  graph: PlaneGraph,
  map: number,
  rooms: readonly WorldRoom[]
): PlaneLayout {
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
      const here = local.get(roomId(room.map, room.room))!;
      for (const { dx, dy, to, destination } of planeSteps(graph, room)) {
        if (destination.map !== map || local.has(to) || at.has(to)) continue;
        const key = cellKey(here.gx + dx, here.gy + dy);
        if (taken.has(key)) {
          spill.push({ room: destination, from: roomId(room.map, room.room), dx, dy });
          continue;
        }
        local.set(to, { gx: here.gx + dx, gy: here.gy + dy });
        taken.add(key);
        queue.push(destination);
      }
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
        ox = at.size === 0 ? 0 : east + 3 - Math.min(...[...local.values()].map((cell) => cell.gx));
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

  constructor(private readonly graph: PlaneGraph & { everyRoom(): Iterable<WorldRoom> }) {}

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
