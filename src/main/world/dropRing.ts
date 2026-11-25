/**
 * Which rooms a hunt for a dropped item walks: of the groups of rooms a
 * dropper turns up in, the one that brings a dropper up soonest counting the
 * walk there, its lairs by how many droppers an hour each brings up, and the
 * rooms the dropper only wanders into spread across the ring so a lap passes
 * through as many of them as it can. `mudengine-world` › `parts/quests.md` ›
 * *A dropper is hunted where it turns up soonest*.
 */
import { WANDERER_CHANCE } from '../../shared/runPass';
import type { RoomId, WorldRoom } from '../../shared/world';
import { lairArrivals, perHour } from './itemRarity';

/** One room a dropper turns up in, priced from where the character stands. */
export interface RingPlace {
  id: RoomId;
  /** The router's cost and the moves of the cheapest way there (`Router.sweepTo`). */
  cost: number;
  moves: number;
  /** The realm places a dropper here; false for a room its group only wanders into. */
  placed: boolean;
  /**
   * Droppers an hour the room brings up. Null where the realm states none: a
   * death that hands the item over, a room that lists none of the rows.
   */
  rate: number | null;
}

/**
 * Droppers an hour one room brings up, `rows` being the dropper's rows and
 * `seconds` the room's clock: a lair's arrivals by the rows of them that
 * drop; a room with no lair draws one of its group's rows at
 * `WANDERER_CHANCE` a clock; a resident comes back on `resident`, its own.
 * Null where the room lists none of the rows, which is unknown, never none.
 */
export function droppersPerHour(
  room: Pick<WorldRoom, 'lair' | 'npcId' | 'wanderers'>,
  rows: ReadonlySet<number>,
  seconds: number,
  resident: (monster: number) => number
): number | null {
  const dropping = (ids: readonly number[]): number => ids.filter((id) => rows.has(id)).length;
  let rate = 0;
  if (room.lair !== undefined) {
    const { ids, each } = lairArrivals(room.lair, seconds);
    rate += each * dropping(ids);
  } else if (room.wanderers !== undefined && room.wanderers.length > 0) {
    const share = dropping(room.wanderers) / room.wanderers.length;
    rate += WANDERER_CHANCE * share * perHour(seconds);
  }
  if (room.npcId !== undefined && rows.has(room.npcId)) rate += perHour(resident(room.npcId));
  return rate > 0 ? rate : null;
}

export interface RingAsk {
  /** The most stops, and how far from its first room a ring reaches. */
  rooms: number;
  radius: number;
  /** A way priced at this or more crosses something the character cannot pass. */
  wallCost: number;
  /** One move of a walk, in seconds. */
  stepSeconds: number;
  /** The moves from one room to every room within `steps` of it. */
  within(from: RoomId, steps: number): ReadonlyMap<RoomId, number>;
}

/**
 * The stops of the hunt, in the order a lap walks them from the one cheapest
 * to reach. `priced` is every room a dropper turns up in that a way reaches,
 * cheapest first. Empty where `priced` is.
 *
 * A ring is weighed round each placement in reach, cheapest first, and a
 * placement inside a ring already weighed is that ring's and starts none of
 * its own. A ring is weighed by its placements alone; the wanderers' rooms
 * that fill it are chosen after, for the winner.
 */
export function pickRing(priced: readonly RingPlace[], ask: RingAsk): RingPlace[] {
  const reached = priced.filter((place) => place.cost < ask.wallCost);
  const centres = reached.filter((place) => place.placed);
  // No placement in reach: the wanderers' rooms alone, else the walk to a wall.
  const fallback = reached[0] ?? priced[0];
  if (centres.length === 0) return fallback === undefined ? [] : stopsOf(fallback, priced, ask);
  let best: { centre: RingPlace; seconds: number } | null = null;
  const covered = new Set<RoomId>();
  for (const centre of centres) {
    if (covered.has(centre.id)) continue;
    const around = ask.within(centre.id, ask.radius);
    const inRing = priced.filter((place) => around.has(place.id));
    for (const place of inRing) covered.add(place.id);
    // The walk there at the router's price, so a way through danger counts as a
    // longer one, then the wait for the first dropper at what the ring brings up.
    const seconds = centre.cost * ask.stepSeconds + waitSeconds(placementsOf(inRing, ask.rooms));
    // Cheapest first, so a ring no sooner than a nearer one never takes its place.
    if (best === null || seconds < best.seconds) best = { centre, seconds };
  }
  return best === null ? [] : stopsOf(best.centre, priced, ask);
}

/**
 * The wait for one dropper at these rooms. A room with no stated rate is
 * waited on for nothing: the walk alone decides, as it did before any room
 * was rated, and a death that hands the item over is never passed by for a
 * rare drop farther off.
 */
function waitSeconds(kept: readonly RingPlace[]): number {
  let rate = 0;
  for (const place of kept) {
    if (place.rate === null) return 0;
    rate += place.rate;
  }
  return rate > 0 ? perHour(rate) : 0;
}

/** The ring's lairs and residents kept under the cap: the unrated, then by what each brings up. */
function placementsOf(inRing: readonly RingPlace[], most: number): RingPlace[] {
  return inRing
    .filter((place) => place.placed)
    .sort((a, b) => (b.rate ?? Infinity) - (a.rate ?? Infinity) || a.cost - b.cost)
    .slice(0, Math.max(1, most));
}

/**
 * The stops round one centre: its ring's placements by rate, and what they
 * leave of the cap filled with wanderers' rooms, each the one farthest from
 * every stop chosen so far, so the lap between them crosses the ring.
 */
function stopsOf(centre: RingPlace, priced: readonly RingPlace[], ask: RingAsk): RingPlace[] {
  const most = Math.max(1, ask.rooms);
  const around = ask.within(centre.id, ask.radius);
  const inRing = priced.filter((place) => around.has(place.id));
  const stops = placementsOf(inRing, most);
  if (stops.length === 0) stops.push(centre);
  // Two rooms of one ring are at most its width apart.
  const width = ask.radius * 2;
  const from = new Map<RoomId, ReadonlyMap<RoomId, number>>();
  const apart = (a: RoomId, b: RoomId): number => {
    let reach = from.get(a);
    if (reach === undefined) {
      reach = ask.within(a, width);
      from.set(a, reach);
    }
    return reach.get(b) ?? width + 1;
  };
  const left = inRing.filter((place) => !place.placed && !stops.includes(place));
  const nearest = new Map(left.map((place) => [place.id, Infinity]));
  const settle = (stop: RingPlace): void => {
    for (const place of left) {
      nearest.set(place.id, Math.min(nearest.get(place.id)!, apart(stop.id, place.id)));
    }
  };
  if (stops.length < most) for (const stop of stops) settle(stop);
  while (stops.length < most && left.length > 0) {
    let pick = 0;
    for (const [index, place] of left.entries()) {
      const far = nearest.get(place.id)! - nearest.get(left[pick]!.id)!;
      if (far > 0 || (far === 0 && (place.rate ?? 0) > (left[pick]!.rate ?? 0))) pick = index;
    }
    const [next] = left.splice(pick, 1);
    stops.push(next!);
    settle(next!);
  }
  // Walked from the stop cheapest to reach, each time to the nearest stop left.
  const order: RingPlace[] = [];
  const unwalked = [...stops].sort((a, b) => a.cost - b.cost || a.moves - b.moves);
  let at = unwalked.shift();
  while (at !== undefined) {
    order.push(at);
    const here = at.id;
    unwalked.sort((a, b) => apart(here, a.id) - apart(here, b.id));
    at = unwalked.shift();
  }
  return order;
}
