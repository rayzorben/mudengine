/**
 * Searching every room near the character: the order the rooms are walked in.
 * The rooms and the moves between them are the navigation engine's
 * (`Navigation.within`); this only orders them. See `mudengine-automation` ›
 * *Searching the area walks each room once*.
 */
import type { RoomId } from './world';

/** The rooms an area search walks, in order, and what it left out. */
export interface AreaPlan {
  origin: RoomId;
  radius: number;
  /** Every room to search, in the order walked, the room the character stands in first. */
  tour: RoomId[];
  /** Moves between the rooms of `tour`, counted on the shortest way between each pair. */
  steps: number;
  /** Rooms within reach where a fight with the room's own monsters is lost. */
  lose: RoomId[];
  /** Rooms within reach where those odds are not worked out yet. */
  unread: RoomId[];
  /** Rooms reached only through a room in `lose` or `unread`. */
  behind: RoomId[];
  /** Every room no walk of this search enters: `lose`, `unread` and the ring past the radius. */
  walled: RoomId[];
  /** Rooms reached from where the character stands that no later room gets back to. */
  stranded: RoomId[];
}

/**
 * The rooms in walking order: from where the character stands, the nearest
 * room not yet in the order, a dead end before the way on where two are as
 * near (the one with fewer rooms left beside it), so a walk does not leave a
 * side room behind and come back for it. A room with no way back to a room
 * already in the order (a one-way drop) is kept for the end, since once in it
 * the rooms behind are out of reach. A room the order cannot reach is
 * `stranded`.
 *
 * `movesFrom(room, most)` is the engine's moves from a room to each room
 * within `most` of it. Each ask starts near and doubles out to `farthest`,
 * since the next room is nearly always a step or two away and a sweep the
 * whole radius wide from every room cost 410ms in Newhaven at fifteen steps.
 */
export function orderTour(
  start: RoomId,
  rooms: ReadonlySet<RoomId>,
  movesFrom: (room: RoomId, most: number) => ReadonlyMap<RoomId, number>,
  farthest: number
): { tour: RoomId[]; steps: number; stranded: RoomId[] } {
  let left = new Set(rooms);
  const tour: RoomId[] = [];
  const walked = new Set<RoomId>([start]);
  const noWayBack: RoomId[] = [];
  let steps = 0;
  let here = start;
  let last = false;
  if (left.delete(start)) tour.push(start);
  const swept = new Map<RoomId, { most: number; moves: ReadonlyMap<RoomId, number> }>();
  const sweep = (room: RoomId, most: number): ReadonlyMap<RoomId, number> => {
    const known = swept.get(room);
    if (known !== undefined && known.most >= most) return known.moves;
    const moves = movesFrom(room, most);
    swept.set(room, { most, moves });
    return moves;
  };
  /** The nearest of `wanted` from `room`, with its moves, every one as near; empty for none. */
  const nearestOf = (
    room: RoomId,
    wanted: (other: RoomId) => boolean
  ): { moves: number; rooms: RoomId[] } => {
    for (let most = 2; ; most = Math.min(most * 2, farthest)) {
      let moves = Number.POSITIVE_INFINITY;
      let rooms: RoomId[] = [];
      for (const [other, away] of sweep(room, most)) {
        if (away > moves || !wanted(other)) continue;
        if (away < moves) [moves, rooms] = [away, []];
        rooms.push(other);
      }
      if (rooms.length > 0 || most >= farthest) return { moves, rooms };
    }
  };
  const besideLeft = (room: RoomId): number => {
    let beside = 0;
    for (const [other, moves] of sweep(room, 1)) if (moves === 1 && left.has(other)) beside += 1;
    return beside;
  };
  for (;;) {
    const { moves, rooms: tied } = nearestOf(here, (room) => left.has(room));
    if (tied.length === 0) {
      // The rooms with no way back, last, walked into from wherever the rest ended.
      if (last || noWayBack.length === 0) break;
      [last, left] = [true, new Set(noWayBack)];
      continue;
    }
    // Counted only among the nearest, so the order stays one sweep per room.
    const next = tied.reduce((best, room) => (besideLeft(room) < besideLeft(best) ? room : best));
    left.delete(next);
    if (!last && nearestOf(next, (room) => walked.has(room)).rooms.length === 0) {
      noWayBack.push(next);
      continue;
    }
    tour.push(next);
    walked.add(next);
    steps += moves;
    here = next;
  }
  return { tour, steps, stranded: [...left] };
}

/** What the dialog shows before the search starts: the bounds, and the plan or why there is none. */
export interface AreaSearchPreview {
  maxRadius: number;
  maxSearches: number;
  /** What the dialog offers before anybody moves a slider. */
  firstRadius: number;
  firstSearches: number;
  /** Auto-combat is off, so a monster that attacks on the way is not fought; null, not known. */
  combatOff: boolean | null;
  plan:
    | {
        rooms: number;
        steps: number;
        /** The names of the rooms left out, by why. */
        lose: string[];
        unread: string[];
        behind: string[];
        stranded: string[];
      }
    | { refused: string };
}
