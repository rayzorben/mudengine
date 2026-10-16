/**
 * The rooms every way into which crosses one kept-out word (todo 145): the
 * Black Wasteland for `vortex`, whose rooms' names do not say it and whose
 * every way in and out is a `go vortex`. A walk that starts there may cross
 * the word (`Router.insideOf`). See `mudengine-world` › `parts/routing.md` ›
 * *A walk that starts inside a place kept out of may leave it*.
 */
import { flood, stronglyConnected } from './components';
import type { RoomId } from '../../shared/world';

/** The realm's moves with every gate open, each marked by whether it crosses the word. */
export interface WordMoves {
  rooms(): Iterable<RoomId>;
  next(room: RoomId): Iterable<{ to: RoomId; crosses: boolean }>;
  /** The rooms an item used anywhere puts the character in: a way in that crosses nothing. */
  landings(): Iterable<RoomId>;
}

/**
 * The realm's body is the largest set of rooms that reach each other without
 * crossing the word; a room is inside the word's places when the body and the
 * item landings reach it, but only across the word. A room nothing reaches
 * is in no place.
 */
export function closedPlaces(moves: WordMoves): ReadonlySet<RoomId> {
  const ids: RoomId[] = [...moves.rooms()];
  const order = new Map<RoomId, number>(ids.map((id, index) => [id, index]));
  const plain: number[][] = [];
  const every: number[][] = [];
  for (const id of ids) {
    const free: number[] = [];
    const all: number[] = [];
    for (const { to, crosses } of moves.next(id)) {
      const index = order.get(to);
      if (index === undefined) continue;
      all.push(index);
      if (!crosses) free.push(index);
    }
    plain.push(free);
    every.push(all);
  }
  const { owner, count } = stronglyConnected(plain);
  const sizes = new Int32Array(count);
  for (const each of owner) sizes[each]! += 1;
  let body = 0;
  for (let each = 1; each < count; each++) if (sizes[each]! > sizes[body]!) body = each;
  const seeds: number[] = [];
  for (let node = 0; node < ids.length; node++) if (owner[node] === body) seeds.push(node);
  for (const room of moves.landings()) {
    const index = order.get(room);
    if (index !== undefined) seeds.push(index);
  }
  const reachedPlain = flood(plain, seeds);
  const reachedAll = flood(every, seeds);
  const inside = new Set<RoomId>();
  for (let node = 0; node < ids.length; node++) {
    if (reachedAll[node] === 1 && reachedPlain[node] === 0) inside.add(ids[node]!);
  }
  return inside;
}
