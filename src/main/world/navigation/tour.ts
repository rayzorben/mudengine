/**
 * The cheapest order to visit one place for each of several things, the
 * engine's one answer to "fetch these, in what order": the quest planner's
 * gathering errand and the gear trip both ask it. Things got in the same rooms
 * are one stop. Up to `exact` stops, Held and Karp's table over the stops (a
 * subset) and the places (where the walk stands); past that, nearest first and
 * then moves and swaps until none shortens the walk, since the table doubles
 * with each stop. `mudengine-world` › *There is one navigation engine*.
 */
import type { RoomId } from '../../../shared/world';
import type { Traveller } from '../Router';

/** One sweep from a room to several, each with the router's cost and the moves it walks. */
export interface TourWorld {
  sweepTo(
    from: RoomId,
    rooms: ReadonlySet<RoomId>,
    traveller: Traveller
  ): ReadonlyMap<RoomId, { cost: number; moves: number }>;
}

export interface TourAsk {
  /** The rooms each thing can be got in, by the thing's index. */
  things: ReadonlyArray<readonly RoomId[]>;
  /** The nearest few rooms of each kept for the table, nearest to the start. */
  places: number;
  /** The most stops ordered exactly; more are ordered nearest first, then improved. */
  exact: number;
  /** Where the walk closes, or null for a walk that ends at its last stop. */
  end: RoomId | null;
  /**
   * Things every other waits on (a vault before the counters it pays): all of
   * these are visited before any thing outside them.
   */
  first?: ReadonlySet<number>;
  /**
   * What a leg weighs: the router's `cost` (doors, lairs and hazards priced) or
   * plain `moves`, for a walk ordered by distance alone.
   */
  by: 'cost' | 'moves';
}

export interface TourStop {
  thing: number;
  room: RoomId;
  /** Moves from the stop before, or from the start. */
  moves: number;
}

export interface TourAnswer {
  /** In walking order; short of `things` by `unreached`. */
  stops: TourStop[];
  /** Moves from the last stop to `end`; null with no `end` or no way to it. */
  home: number | null;
  /** Things no kept room of which the walk reaches from the start. */
  unreached: number[];
}

/**
 * The order, from `from`; null where no order reaches every reachable thing
 * (the realm's one-way exits keep a pair apart).
 */
export function tour(
  world: TourWorld,
  from: RoomId,
  ask: TourAsk,
  traveller: Traveller
): TourAnswer | null {
  const asked = new Set<RoomId>(ask.things.flat());
  if (ask.end !== null) asked.add(ask.end);
  const reach = world.sweepTo(from, asked, traveller);
  const weigh = (leg: { cost: number; moves: number }): number =>
    ask.by === 'cost' ? leg.cost : leg.moves;

  /*
   * The nearest few rooms for each, nearest to the start, the one distance
   * already in hand: a room further off than three others is not where the
   * shortest walk goes unless it was going that way anyway, and the ones kept
   * are then weighed against the whole walk.
   */
  const nodes: TourNode[] = [];
  const unreached: number[] = [];
  // The things of each stop: those whose kept rooms are the same, bought in one visit.
  const members: number[][] = [];
  const stopOf = new Map<string, number>();
  const firstStops = new Set<number>();
  ask.things.forEach((rooms, thing) => {
    const near = [...new Set(rooms)]
      .filter((room) => reach.has(room))
      .sort((a, b) => weigh(reach.get(a)!) - weigh(reach.get(b)!))
      .slice(0, ask.places);
    if (near.length === 0) {
      unreached.push(thing);
      return;
    }
    const first = ask.first?.has(thing) === true;
    const key = `${first ? 'first' : ''}|${[...near].sort().join(',')}`;
    const known = stopOf.get(key);
    if (known !== undefined) {
      members[known]!.push(thing);
      return;
    }
    const stop = members.length;
    stopOf.set(key, stop);
    members.push([thing]);
    if (first) firstStops.add(stop);
    for (const room of near) nodes.push({ thing: stop, room });
  });
  if (nodes.length === 0) return { stops: [], home: null, unreached };

  const kept = new Set<RoomId>(nodes.map((node) => node.room));
  if (ask.end !== null) kept.add(ask.end);
  const between = new Map<RoomId, ReadonlyMap<RoomId, { cost: number; moves: number }>>();
  for (const node of nodes) {
    if (!between.has(node.room)) between.set(node.room, world.sweepTo(node.room, kept, traveller));
  }

  const end = ask.end;
  const legs: Legs = {
    leg: (from, to) => (from === null ? reach : between.get(from))?.get(to),
    home: (last) => (end === null ? undefined : between.get(last)?.get(end)),
    /*
     * The way home is part of the order, not a figure added after it: the
     * nearest four things in the wrong order end a long way from the asker.
     * Where the walk cannot close at all (a one-way exit out of the last room)
     * the order is still right for the pickups, so the way home costs nothing.
     */
    homeCost: (last) => {
      const back = legs.home(last);
      return back === undefined ? 0 : weigh(back);
    },
    weigh
  };
  const solve = members.length <= ask.exact ? bestOrder : quickOrder;
  const order = solve(nodes, legs, firstStops);
  if (order === null) return null;
  const stops: TourStop[] = [];
  let previous: RoomId | null = null;
  for (const index of order) {
    const node = nodes[index]!;
    const leg = legs.leg(previous, node.room)!;
    members[node.thing]!.forEach((thing, nth) => {
      stops.push({ thing, room: node.room, moves: nth === 0 ? leg.moves : 0 });
    });
    previous = node.room;
  }
  const home = previous === null ? null : (legs.home(previous)?.moves ?? null);
  return { stops, home, unreached };
}

interface TourNode {
  /** The stop: one or more things got in the same rooms. */
  thing: number;
  room: RoomId;
}

type Leg = { cost: number; moves: number };

/** The legs between kept rooms, from the start (`null`) and home, as both orders weigh them. */
interface Legs {
  leg(from: RoomId | null, to: RoomId): Leg | undefined;
  home(last: RoomId): Leg | undefined;
  homeCost(last: RoomId): number;
  weigh(leg: Leg): number;
}

/**
 * The cheapest order to visit one place for each thing, ending at `end`.
 * The subset is over things and the position over places. `first` holds the
 * things every other waits on.
 */
function bestOrder(
  raw: readonly TourNode[],
  legs: Legs,
  firstThings: ReadonlySet<number>
): number[] | null {
  // Things without a reached room are not in the table, so the bits are the reached ones.
  const bitOf = new Map<number, number>();
  for (const node of raw) if (!bitOf.has(node.thing)) bitOf.set(node.thing, bitOf.size);
  const nodes = raw.map((node) => ({ bit: 1 << bitOf.get(node.thing)!, room: node.room }));
  let firstMask = 0;
  for (const thing of firstThings) {
    const bit = bitOf.get(thing);
    if (bit !== undefined) firstMask |= 1 << bit;
  }
  const full = (1 << bitOf.size) - 1;
  const width = nodes.length;
  const best = new Float64Array((full + 1) * width).fill(Number.POSITIVE_INFINITY);
  const came = new Int32Array((full + 1) * width).fill(-1);
  // A thing outside `first` may be stood at only once every one of `first` is held.
  const open = (mask: number, bit: number): boolean =>
    (firstMask & bit) !== 0 || (mask & firstMask) === firstMask;

  for (let at = 0; at < width; at += 1) {
    const first = legs.leg(null, nodes[at]!.room);
    if (first !== undefined && open(0, nodes[at]!.bit)) {
      best[nodes[at]!.bit * width + at] = legs.weigh(first);
    }
  }
  for (let mask = 1; mask <= full; mask += 1) {
    for (let at = 0; at < width; at += 1) {
      const cost = best[mask * width + at]!;
      if (!Number.isFinite(cost)) continue;
      const room = nodes[at]!.room;
      for (let next = 0; next < width; next += 1) {
        const bit = nodes[next]!.bit;
        if ((mask & bit) !== 0 || !open(mask, bit)) continue;
        const leg = legs.leg(room, nodes[next]!.room);
        if (leg === undefined) continue;
        const total = cost + legs.weigh(leg);
        const slot = (mask | bit) * width + next;
        if (total >= best[slot]!) continue;
        best[slot] = total;
        came[slot] = at;
      }
    }
  }

  let cheapest = Number.POSITIVE_INFINITY;
  let last = -1;
  for (let at = 0; at < width; at += 1) {
    const cost = best[full * width + at]!;
    if (!Number.isFinite(cost)) continue;
    const total = cost + legs.homeCost(nodes[at]!.room);
    if (total >= cheapest) continue;
    cheapest = total;
    last = at;
  }
  if (last === -1) return null;

  const walk: number[] = [];
  let mask = full;
  let cursor = last;
  while (cursor !== -1) {
    walk.unshift(cursor);
    const before = came[mask * width + cursor]!;
    mask &= ~nodes[cursor]!.bit;
    cursor = before;
  }
  return walk;
}

/**
 * An order too long for the table: nearest first, `first` before the rest,
 * then the walk is improved while any change shortens it. A change is moving
 * one stop elsewhere in the walk, turning a stretch of it round, or getting a
 * thing at another of its rooms. Each pass is cubic in the stops, and the
 * walk only ever gets cheaper, so it ends.
 */
function quickOrder(
  nodes: readonly TourNode[],
  legs: Legs,
  first: ReadonlySet<number>
): number[] | null {
  const roomsOf = new Map<number, number[]>();
  nodes.forEach((node, at) => roomsOf.set(node.thing, [...(roomsOf.get(node.thing) ?? []), at]));
  const legCost = (from: number | null, to: number): number => {
    const leg = legs.leg(from === null ? null : nodes[from]!.room, nodes[to]!.room);
    return leg === undefined ? Number.POSITIVE_INFINITY : legs.weigh(leg);
  };
  const total = (walk: readonly number[]): number => {
    let sum = 0;
    let previous: number | null = null;
    for (const at of walk) {
      sum += legCost(previous, at);
      previous = at;
    }
    return previous === null ? sum : sum + legs.homeCost(nodes[previous]!.room);
  };
  // No stop outside `first` comes before one inside it.
  const keepsFirst = (walk: readonly number[]): boolean => {
    let opened = false;
    for (const at of walk) {
      const inFirst = first.has(nodes[at]!.thing);
      if (opened && inFirst) return false;
      if (!inFirst) opened = true;
    }
    return true;
  };

  let walk: number[] = [];
  const left = new Set(roomsOf.keys());
  for (let previous: number | null = null; left.size > 0;) {
    const firstLeft = [...left].some((stop) => first.has(stop));
    let pick = -1;
    let cheapest = Number.POSITIVE_INFINITY;
    for (const stop of left) {
      if (firstLeft && !first.has(stop)) continue;
      for (const at of roomsOf.get(stop)!) {
        const cost = legCost(previous, at);
        if (cost < cheapest) {
          cheapest = cost;
          pick = at;
        }
      }
    }
    // A one-way pocket: what is left goes in wherever the walk reaches it.
    if (pick === -1) break;
    walk.push(pick);
    left.delete(nodes[pick]!.thing);
    previous = pick;
  }
  for (const stop of left) {
    let placed: number[] | null = null;
    let cheapest = Number.POSITIVE_INFINITY;
    for (const at of roomsOf.get(stop)!) {
      for (let i = 0; i <= walk.length; i += 1) {
        const candidate = walk.toSpliced(i, 0, at);
        if (!keepsFirst(candidate)) continue;
        const cost = total(candidate);
        if (cost < cheapest) {
          cheapest = cost;
          placed = candidate;
        }
      }
    }
    if (placed === null) return null;
    walk = placed;
  }

  let best = total(walk);
  const consider = (candidate: number[]): boolean => {
    if (!keepsFirst(candidate)) return false;
    const cost = total(candidate);
    if (cost >= best) return false;
    best = cost;
    walk = candidate;
    return true;
  };
  for (let improved = true; improved;) {
    improved = false;
    for (let i = 0; i < walk.length; i += 1) {
      for (const at of roomsOf.get(nodes[walk[i]!]!.thing)!) {
        if (at !== walk[i] && consider(walk.with(i, at))) improved = true;
      }
      for (let j = 0; j < walk.length; j += 1) {
        if (j === i) continue;
        if (consider(walk.toSpliced(i, 1).toSpliced(j, 0, walk[i]!))) improved = true;
        if (j <= i + 1) continue;
        const turned = walk.slice(i, j + 1).reverse();
        if (consider(walk.toSpliced(i, turned.length, ...turned))) improved = true;
      }
    }
  }
  return walk;
}
