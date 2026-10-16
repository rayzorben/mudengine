/**
 * Every room of one map on floors, for the game view (todo 140, floors todo
 * 151). A floor number per room first: up is one more, down one less, a
 * compass exit the same, followed from either end of an exit. Then each floor
 * is laid out breadth-first over `planeSteps`, nothing dropped: a room whose
 * cell is taken starts an island pushed out along the exit that reached it; a
 * floor reached by stairs starts on the stairs' own cell when it fits; a
 * room's teleport sets its landing east of it; a room nothing on the map
 * reaches starts one `UNJOINED_GAP` east of everything. Laid out on first ask
 * and kept. The reasons are in `mudengine-world` › `parts/realm.md` › *The game
 * view's map*.
 */
import { cellKey, type GameStair } from '../../shared/gameMap';
import { roomId, type RoomId, type WorldRoom } from '../../shared/world';
import { leapSteps, planeSteps, type LeapGraph } from './planeSteps';

export interface PlanePlace {
  gx: number;
  gy: number;
  /** The floor: 0 for the first room laid out, one more for each way up. */
  z: number;
}

export interface PlaneLayout {
  readonly map: number;
  /** Where each room of the map sits. */
  readonly at: ReadonlyMap<RoomId, PlanePlace>;
  /** Which room sits in a cell, by `floorCellKey`. */
  readonly cells: ReadonlyMap<string, RoomId>;
  /** Which island each room belongs to; a stretch label never crosses one. */
  readonly island: ReadonlyMap<RoomId, number>;
  /** Each room's stairs, every climb through one-room floors already followed. */
  readonly stairs: ReadonlyMap<RoomId, readonly GameStair[]>;
}

/** A cell of one floor, for looking a room up by where it sits. */
export const floorCellKey = (z: number, gx: number, gy: number): string =>
  `${z}:${cellKey(gx, gy)}`;

/**
 * Cells of air between islands no way on the map joins, so one never reads as
 * part of the area beside it (three cells did: a ganghouse's Rubbish Disposal
 * Chamber stood at the Crimson Fortress's door).
 */
export const UNJOINED_GAP = 10;

/** A way from one room of the map to another: a compass step, stairs or a teleport. */
interface Link {
  to: RoomId;
  destination: WorldRoom;
  dx: number;
  dy: number;
  /** One floor up, one down, or the same floor. */
  dz: -1 | 0 | 1;
  /** A teleport's landing keeps no floor of its own: it is counted from the other ways. */
  teleport: boolean;
}

interface Spill {
  room: WorldRoom;
  /** The placed room whose way could not take the cell, or leaves the floor. */
  from: RoomId;
  link: Link;
}

const idOf = (room: WorldRoom): RoomId => roomId(room.map, room.room);

/** Each room's ways to other rooms of the map, its own first, then the ones that lead in. */
function linksOf(
  graph: LeapGraph,
  map: number,
  rooms: readonly WorldRoom[]
): { steps: Map<RoomId, Link[]>; leaps: Map<RoomId, Link[]> } {
  const steps = new Map<RoomId, Link[]>();
  const leaps = new Map<RoomId, Link[]>();
  const add = (into: Map<RoomId, Link[]>, id: RoomId, link: Link) => {
    const held = into.get(id);
    if (held) held.push(link);
    else into.set(id, [link]);
  };
  const inward: Array<[Map<RoomId, Link[]>, RoomId, Link]> = [];
  const both = (into: Map<RoomId, Link[]>, room: WorldRoom, link: Link) => {
    add(into, idOf(room), link);
    inward.push([
      into,
      link.to,
      {
        to: idOf(room),
        destination: room,
        dx: -link.dx,
        dy: -link.dy,
        dz: -link.dz as Link['dz'],
        teleport: link.teleport
      }
    ]);
  };
  for (const room of rooms) {
    for (const { dx, dy, to, destination } of planeSteps(graph, room))
      if (destination.map === map)
        both(steps, room, { to, destination, dx, dy, dz: 0, teleport: false });
    for (const way of leapSteps(graph, room))
      if (way.destination.map === map)
        both(leaps, room, {
          to: way.to,
          destination: way.destination,
          dx: 0,
          dy: 0,
          dz: way.kind === 'up' ? 1 : way.kind === 'down' ? -1 : 0,
          teleport: way.kind === 'teleport'
        });
  }
  for (const [into, id, link] of inward) add(into, id, link);
  return { steps, leaps };
}

/**
 * A floor number per room, breadth-first from the lowest-numbered room not yet
 * reached. A room reached two ways that disagree keeps the first: the stairs'
 * mark then says so (`GameStair.odd`).
 */
function floorsOf(
  rooms: readonly WorldRoom[],
  steps: ReadonlyMap<RoomId, Link[]>,
  leaps: ReadonlyMap<RoomId, Link[]>
): Map<RoomId, number> {
  const z = new Map<RoomId, number>();
  for (const root of rooms) {
    if (z.has(idOf(root))) continue;
    z.set(idOf(root), 0);
    const queue = [root];
    for (let head = 0; head < queue.length; head += 1) {
      const id = idOf(queue[head]!);
      const here = z.get(id)!;
      for (const link of [...(steps.get(id) ?? []), ...(leaps.get(id) ?? [])]) {
        if (link.teleport || z.has(link.to)) continue;
        z.set(link.to, here + link.dz);
        queue.push(link.destination);
      }
    }
  }
  return z;
}

/**
 * Where each of a room's own stairs leads, through any climb of one-room floors:
 * a room with no compass way on the map and stairs on the same way is passed
 * through and counted, so a shaft of eight landings is one mark (▼8) to the
 * room the climb ends in.
 */
function stairsOf(
  graph: LeapGraph,
  room: WorldRoom,
  z: ReadonlyMap<RoomId, number>,
  steps: ReadonlyMap<RoomId, Link[]>
): GameStair[] {
  const out: GameStair[] = [];
  const from = idOf(room);
  const nextOf = (at: WorldRoom, kind: 'up' | 'down') => {
    for (const way of leapSteps(graph, at)) if (way.kind === kind) return way;
    return null;
  };
  for (const kind of ['up', 'down'] as const) {
    const first = nextOf(room, kind);
    if (first === null) continue;
    let end = first.destination;
    let floors = 1;
    const seen = new Set([from]);
    while (end.map === room.map && !seen.has(idOf(end)) && !steps.has(idOf(end))) {
      const next = nextOf(end, kind);
      if (next === null) break;
      seen.add(idOf(end));
      end = next.destination;
      floors += 1;
    }
    const to = idOf(end);
    const floor = end.map === room.map ? (z.get(to) ?? null) : null;
    const expected = z.get(from)! + (kind === 'up' ? floors : -floors);
    out.push({
      direction: kind === 'up' ? 'u' : 'd',
      to,
      name: end.name,
      floor,
      floors,
      ...(floor !== null && floor !== expected ? { odd: true as const } : {})
    });
  }
  return out;
}

export function layOutMap(graph: LeapGraph, map: number, rooms: readonly WorldRoom[]): PlaneLayout {
  const ordered = [...rooms].sort((a, b) => a.room - b.room);
  const { steps, leaps } = linksOf(graph, map, ordered);
  const z = floorsOf(ordered, steps, leaps);
  const at = new Map<RoomId, PlanePlace>();
  const cells = new Map<string, RoomId>();
  const island = new Map<RoomId, number>();
  let islands = 0;
  let east = 0;

  /** One island of one floor from a seed, in its own coordinates, and the rooms it could not place. */
  const grow = (
    seed: WorldRoom,
    floor: number
  ): { local: Map<RoomId, { gx: number; gy: number }>; spill: Spill[] } => {
    const local = new Map([[idOf(seed), { gx: 0, gy: 0 }]]);
    const taken = new Set([floorCellKey(floor, 0, 0)]);
    const spill: Spill[] = [];
    const queue: WorldRoom[] = [seed];
    for (let head = 0; head < queue.length; head += 1) {
      const id = idOf(queue[head]!);
      const here = local.get(id)!;
      for (const link of steps.get(id) ?? []) {
        if (local.has(link.to) || at.has(link.to)) continue;
        const key = floorCellKey(floor, here.gx + link.dx, here.gy + link.dy);
        if (z.get(link.to) !== floor || taken.has(key)) {
          spill.push({ room: link.destination, from: id, link });
          continue;
        }
        local.set(link.to, { gx: here.gx + link.dx, gy: here.gy + link.dy });
        taken.add(key);
        queue.push(link.destination);
      }
    }
    // The stairs and teleports, once the island's own rooms are all placed.
    for (const room of queue) {
      const id = idOf(room);
      for (const link of leaps.get(id) ?? [])
        if (!local.has(link.to) && !at.has(link.to))
          spill.push({ room: link.destination, from: id, link });
    }
    return { local, spill };
  };

  /** Whether an island fits at an offset: every cell free, and with `margin` free around each. */
  const fits = (
    local: Map<RoomId, { gx: number; gy: number }>,
    floor: number,
    ox: number,
    oy: number,
    margin: 0 | 1
  ): boolean => {
    for (const { gx, gy } of local.values())
      for (let dx = -margin; dx <= margin; dx += 1)
        for (let dy = -margin; dy <= margin; dy += 1)
          if (cells.has(floorCellKey(floor, gx + ox + dx, gy + oy + dy))) return false;
    return true;
  };

  const commit = (
    local: Map<RoomId, { gx: number; gy: number }>,
    floor: number,
    ox: number,
    oy: number
  ) => {
    for (const [id, { gx, gy }] of local) {
      const placed = { gx: gx + ox, gy: gy + oy, z: floor };
      at.set(id, placed);
      cells.set(floorCellKey(floor, placed.gx, placed.gy), id);
      island.set(id, islands);
      east = Math.max(east, placed.gx);
    }
    islands += 1;
  };

  /** Where an island reached from a placed room goes: on the stairs' cell, else pushed out. */
  const offsetOf = (
    local: Map<RoomId, { gx: number; gy: number }>,
    floor: number,
    parent: PlanePlace,
    link: Link
  ): { ox: number; oy: number } => {
    if (link.dz !== 0 && fits(local, floor, parent.gx, parent.gy, 0))
      return { ox: parent.gx, oy: parent.gy };
    // Stairs that cannot land on their own cell, and a teleport, go east.
    const along = link.dz !== 0 || link.teleport ? { dx: 1, dy: 0 } : link;
    let reach = link.dz !== 0 ? 1 : 2;
    for (;;) {
      const ox = parent.gx + along.dx * reach;
      const oy = parent.gy + along.dy * reach;
      if (fits(local, floor, ox, oy, 1)) return { ox, oy };
      reach += 1;
    }
  };

  for (const root of ordered) {
    if (at.has(idOf(root))) continue;
    const pending: Array<Spill | { room: WorldRoom; from: null }> = [{ room: root, from: null }];
    for (let head = 0; head < pending.length; head += 1) {
      const next = pending[head]!;
      if (at.has(idOf(next.room))) continue;
      const floor = z.get(idOf(next.room))!;
      const { local, spill } = grow(next.room, floor);
      const { ox, oy } =
        next.from === null
          ? {
              ox:
                at.size === 0
                  ? 0
                  : east + UNJOINED_GAP - Math.min(...[...local.values()].map((cell) => cell.gx)),
              oy: 0
            }
          : offsetOf(local, floor, at.get(next.from)!, next.link);
      commit(local, floor, ox, oy);
      pending.push(...spill);
    }
  }

  const stairs = new Map<RoomId, readonly GameStair[]>();
  for (const room of ordered) {
    const own = stairsOf(graph, room, z, steps);
    if (own.length > 0) stairs.set(idOf(room), own);
  }
  return { map, at, cells, island, stairs };
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
