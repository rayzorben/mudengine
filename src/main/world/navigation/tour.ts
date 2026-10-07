/**
 * The cheapest order to visit one place for each of several things, the
 * engine's one answer to "fetch these, in what order": the quest planner's
 * gathering errand and the gear trip both ask it. Held and Karp's table over
 * the things (a subset) and the places (where the walk stands), so a thing got
 * in three rooms costs three columns, not three things' worth of table.
 * `mudengine-world` › *There is one navigation engine*.
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
  ask.things.forEach((rooms, thing) => {
    const near = [...new Set(rooms)]
      .filter((room) => reach.has(room))
      .sort((a, b) => weigh(reach.get(a)!) - weigh(reach.get(b)!))
      .slice(0, ask.places);
    if (near.length === 0) unreached.push(thing);
    for (const room of near) nodes.push({ thing, room });
  });
  if (nodes.length === 0) return { stops: [], home: null, unreached };

  const kept = new Set<RoomId>(nodes.map((node) => node.room));
  if (ask.end !== null) kept.add(ask.end);
  const between = new Map<RoomId, ReadonlyMap<RoomId, { cost: number; moves: number }>>();
  for (const node of nodes) {
    if (!between.has(node.room)) between.set(node.room, world.sweepTo(node.room, kept, traveller));
  }

  const order = bestOrder(nodes, reach, between, ask.end, ask.first ?? new Set(), weigh);
  if (order === null) return null;
  const stops: TourStop[] = [];
  let previous: RoomId | null = null;
  for (const index of order) {
    const node = nodes[index]!;
    const leg = (previous === null ? reach : between.get(previous)!).get(node.room)!;
    stops.push({ thing: node.thing, room: node.room, moves: leg.moves });
    previous = node.room;
  }
  const home =
    ask.end === null || previous === null
      ? null
      : (between.get(previous)?.get(ask.end)?.moves ?? null);
  return { stops, home, unreached };
}

interface TourNode {
  /** Re-indexed below to the reached things only. */
  thing: number;
  room: RoomId;
}

/**
 * The cheapest order to visit one place for each thing, ending at `end`.
 * The subset is over things and the position over places. `first` holds the
 * things every other waits on. The way home is part of the order, not a
 * figure added after it: the nearest four things in the wrong order end a
 * long way from the asker. Where the walk cannot close at all (a one-way exit
 * out of the last room) the order is still right for the pickups, so the way
 * home costs nothing then.
 */
function bestOrder(
  raw: readonly TourNode[],
  reach: ReadonlyMap<RoomId, { cost: number; moves: number }>,
  between: ReadonlyMap<RoomId, ReadonlyMap<RoomId, { cost: number; moves: number }>>,
  end: RoomId | null,
  firstThings: ReadonlySet<number>,
  weigh: (leg: { cost: number; moves: number }) => number
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
    const first = reach.get(nodes[at]!.room);
    if (first !== undefined && open(0, nodes[at]!.bit)) {
      best[nodes[at]!.bit * width + at] = weigh(first);
    }
  }
  for (let mask = 1; mask <= full; mask += 1) {
    for (let at = 0; at < width; at += 1) {
      const cost = best[mask * width + at]!;
      if (!Number.isFinite(cost)) continue;
      const onward = between.get(nodes[at]!.room);
      if (onward === undefined) continue;
      for (let next = 0; next < width; next += 1) {
        const bit = nodes[next]!.bit;
        if ((mask & bit) !== 0 || !open(mask, bit)) continue;
        const leg = onward.get(nodes[next]!.room);
        if (leg === undefined) continue;
        const total = cost + weigh(leg);
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
    const back = end === null ? undefined : between.get(nodes[at]!.room)?.get(end);
    const total = cost + (back === undefined ? 0 : weigh(back));
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
