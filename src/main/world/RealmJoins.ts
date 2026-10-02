/**
 * Whether the realm joins two rooms at all: a path over every exit, portal,
 * draw and item landing, whatever a gate on it asks. A superset of any
 * traveller's reach, so it only ever rules a search out. Built once per
 * realm: the strongly connected components, and per start the components it
 * reaches. See `mudengine-world` › *A room nothing joins is ruled out once*.
 */
import type { RoomId } from '../../shared/world';

/** The realm's moves with every gate open, as `RealmJoins` reads them. */
export interface JoinMoves {
  rooms(): Iterable<RoomId>;
  /** Every room one move from `room` reaches, gates ignored; a draw is each room it can land in. */
  next(room: RoomId): Iterable<RoomId>;
  /** The rooms an item used anywhere puts the character in. */
  landings(): Iterable<RoomId>;
}

/** How many starts' reach is kept; a start is the component the character stands in. */
const KEPT_STARTS = 16;

export class RealmJoins {
  /** Each room's component. */
  private readonly component = new Map<RoomId, number>();
  /** The components each component's moves lead to, itself left out. */
  private readonly leads: number[][] = [];
  /** The components the item landings start in. */
  private readonly landed: number[] = [];
  /** What each start reaches, newest last. */
  private readonly reach = new Map<number, Uint8Array>();

  constructor(moves: JoinMoves) {
    this.build(moves);
  }

  /** False only where no path at all leads from `from` to `to`. */
  joined(from: RoomId, to: RoomId): boolean {
    const start = this.component.get(from);
    const end = this.component.get(to);
    // A room the realm does not hold is not this check's to rule on.
    if (start === undefined || end === undefined) return true;
    if (start === end) return true;
    return this.reached(start)[end] === 1;
  }

  private reached(start: number): Uint8Array {
    const kept = this.reach.get(start);
    if (kept !== undefined) {
      this.reach.delete(start);
      this.reach.set(start, kept);
      return kept;
    }
    const seen = new Uint8Array(this.leads.length);
    const stack = [start, ...this.landed];
    for (const each of stack) seen[each] = 1;
    while (stack.length > 0) {
      for (const next of this.leads[stack.pop()!]!) {
        if (seen[next] === 1) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    if (this.reach.size >= KEPT_STARTS) this.reach.delete(this.reach.keys().next().value!);
    this.reach.set(start, seen);
    return seen;
  }

  /** Tarjan's components, iteratively: a realm's corridors are deeper than the call stack. */
  private build(moves: JoinMoves): void {
    const ids: RoomId[] = [...moves.rooms()];
    const order = new Map<RoomId, number>(ids.map((id, index) => [id, index]));
    const out: number[][] = ids.map((id) =>
      [...moves.next(id)].flatMap((next) => {
        const index = order.get(next);
        return index === undefined ? [] : [index];
      })
    );
    const count = ids.length;
    const index = new Int32Array(count).fill(-1);
    const low = new Int32Array(count);
    const onStack = new Uint8Array(count);
    const owner = new Int32Array(count);
    const stack: number[] = [];
    let counter = 0;
    let components = 0;
    for (let root = 0; root < count; root++) {
      if (index[root] !== -1) continue;
      const frames: Array<{ node: number; edge: number }> = [{ node: root, edge: 0 }];
      index[root] = low[root] = counter++;
      stack.push(root);
      onStack[root] = 1;
      while (frames.length > 0) {
        const frame = frames[frames.length - 1]!;
        const edges = out[frame.node]!;
        if (frame.edge < edges.length) {
          const next = edges[frame.edge++]!;
          if (index[next] === -1) {
            index[next] = low[next] = counter++;
            stack.push(next);
            onStack[next] = 1;
            frames.push({ node: next, edge: 0 });
          } else if (onStack[next] === 1) {
            low[frame.node] = Math.min(low[frame.node]!, index[next]!);
          }
          continue;
        }
        frames.pop();
        const parent = frames[frames.length - 1];
        if (parent !== undefined) low[parent.node] = Math.min(low[parent.node]!, low[frame.node]!);
        if (low[frame.node] !== index[frame.node]) continue;
        let member: number;
        do {
          member = stack.pop()!;
          onStack[member] = 0;
          owner[member] = components;
        } while (member !== frame.node);
        components += 1;
      }
    }
    const leads = Array.from({ length: components }, () => new Set<number>());
    for (let node = 0; node < count; node++) {
      this.component.set(ids[node]!, owner[node]!);
      for (const next of out[node]!) {
        if (owner[next] !== owner[node]) leads[owner[node]!]!.add(owner[next]!);
      }
    }
    this.leads.push(...leads.map((each) => [...each]));
    const landed = new Set<number>();
    for (const room of moves.landings()) {
      const at = this.component.get(room);
      if (at !== undefined) landed.add(at);
    }
    this.landed.push(...landed);
  }
}
