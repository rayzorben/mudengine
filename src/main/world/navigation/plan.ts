/**
 * The plan to get from one room to another, whole before the first step: the
 * keys the way wants (`keysWanted`), each fetched from where the realm gives
 * it (`sources.ts`) in the order they can be had, so a key behind an earlier
 * key's door comes after it; the fights it takes, weighed as combat weighs
 * them; and the rooms a way wants empty, cleared. A route that crosses a wall
 * is never a way, and every leg is planned before the first is walked, so a
 * one-way move is only planned where the plan from its far side exists.
 * `mudengine-world` › *There is one navigation engine*.
 */
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import {
  isFetch,
  planRefusalsWords,
  type FightOdds,
  type NavigationOracle,
  type Plan,
  type PlannedItem,
  type PlanRefusal,
  type PlanStep
} from '../../../shared/navigation';
import {
  blockItem,
  describeBlock,
  itemDemanded,
  type RoomId,
  type Route
} from '../../../shared/world';
import type { RouteOptions, Traveller } from '../Router';
import type { ItemSource } from './sources';

/** What the planner reads of the realm. */
export interface PlanRealm {
  route(from: RoomId, to: RoomId, traveller: Traveller, options?: RouteOptions): Route;
  /** What reaching each of these rooms costs, one search for all (`Router.sweepTo`). */
  sweep(
    from: RoomId,
    rooms: ReadonlySet<RoomId>,
    traveller: Traveller
  ): ReadonlyMap<RoomId, { cost: number }>;
  sources(item: number): readonly ItemSource[];
  /** Every monster that stands in the room: its lair and its residents. */
  standing(room: RoomId): readonly string[];
  /** The room's name, for a reader. */
  roomName(room: RoomId): string;
  /** Every item the realm demands on an exit and names (`Router.namedExitItems`). */
  keysNamed(): readonly number[];
  /** An item's name, for a reader. */
  itemName(item: number): string | undefined;
}

/** A route this character can walk: found, and crossing no wall. */
function walkable(route: Route): boolean {
  return !route.blocked && (route.walls ?? []).length === 0;
}

/** Why a route is no way: the router's reason, or the walls it crosses in its own words. */
function noWay(route: Route): PlanRefusal {
  return { kind: 'no-way', why: noWayWords(route) };
}

/** Why a route is no way, in words: the router's reason, or the walls it crosses. */
function noWayWords(route: Route): string {
  return route.reason ?? (route.walls ?? []).map(describeBlock).join('; ');
}

/**
 * The keys a way wants: planned holding the items its refusal names, where
 * those alone open it, else holding every item the realm names on an exit.
 * What the way found uses and the pack lacks is wanted, so a second lock
 * nobody reached is found as well as the first. Only a refusal a door or an
 * item explains is asked: a search holding every key, for a way a level or a
 * class shuts, costs a pass of the realm and finds nothing.
 */
function keysWanted(
  realm: PlanRealm,
  from: RoomId,
  to: RoomId,
  traveller: Traveller,
  direct: Route
): PlannedItem[] {
  const named = (direct.blocked ? direct.blocks : direct.walls) ?? [];
  const doors = named.some(
    (block) => block.kind === 'key' || block.kind === 'door' || block.kind === 'carry'
  );
  if (!doors) return [];
  const refused = named.map(blockItem);
  const tries: Array<readonly number[]> = [];
  if (refused.every((item) => item !== null)) tries.push(refused.map((item) => item!.id));
  tries.push(realm.keysNamed());
  for (const extra of tries) {
    const held = wayHolding(realm, from, to, traveller, extra);
    if (held !== null && held.needs.length > 0) return held.needs;
  }
  return [];
}

/**
 * The way when the pack also holds `extra`, and the items its steps use that
 * the pack does not hold; null where there is no walk, or none within
 * `within`.
 */
function wayHolding(
  realm: PlanRealm,
  from: RoomId,
  to: RoomId,
  traveller: Traveller,
  extra: readonly number[],
  within?: number
): { way: Route; needs: PlannedItem[] } | null {
  const held = traveller.keys ?? [];
  const keys = [...new Set([...held, ...extra])];
  const options: RouteOptions = within === undefined ? {} : { within };
  const way = realm.route(from, to, { ...traveller, keys }, options);
  return walkable(way) ? { way, needs: keysUsed(realm, way, held) } : null;
}

/** The items a way's steps demand that the pack does not hold, each once, in order. */
function keysUsed(realm: PlanRealm, way: Route, held: readonly number[]): PlannedItem[] {
  const needs = new Map<number, PlannedItem>();
  for (const step of way.steps) {
    const id = itemDemanded(step.requirement);
    if (id === null || held.includes(id) || needs.has(id)) continue;
    needs.set(id, { id, name: realm.itemName(id) ?? `#${id}` });
  }
  return [...needs.values()];
}

/** The fights a step takes: a summoner first where one brings the monster. */
function fightsOf(source: ItemSource): string[] {
  if (source.kind !== 'kill') return [];
  return source.summon !== undefined && 'by' in source.summon
    ? [source.summon.by, source.monster]
    : [source.monster];
}

type Leg =
  { kind: 'leg'; steps: PlanStep[]; cost: number } | { kind: 'refused'; refusal: PlanRefusal };

/**
 * The walk from one room to another holding these items, split at every way
 * through that wants its room empty (`nomonsters`): walk there, clear it,
 * walk on. Every monster standing there is a fight weighed first.
 */
function walk(
  realm: PlanRealm,
  oracle: NavigationOracle,
  from: RoomId,
  to: RoomId,
  traveller: Traveller,
  known?: Route
): Leg {
  if (from === to) return { kind: 'leg', steps: [], cost: 0 };
  const route = known ?? realm.route(from, to, traveller);
  if (!walkable(route)) return { kind: 'refused', refusal: noWay(route) };
  // A slice is its steps and its share of the cost; the walls and hazards are the whole route's.
  const part = (start: number, end: number): PlanStep => ({
    kind: 'walk',
    route: {
      steps: route.steps.slice(start, end),
      cost: (route.cost * (end - start)) / Math.max(1, route.steps.length),
      blocked: false
    }
  });
  const steps: PlanStep[] = [];
  let cost = route.cost;
  let start = 0;
  for (const [index, step] of route.steps.entries()) {
    if (!(step.requirement?.gates ?? []).some((gate) => gate.kind === 'empty-room')) continue;
    const room = step.from;
    const monsters = [...realm.standing(room)];
    // Nobody standing there: the way is open as it is.
    if (monsters.length === 0) continue;
    for (const monster of monsters) {
      const refusal = refusedFight(oracle.fight(monster, room), monster, null);
      if (refusal !== null) return { kind: 'refused', refusal };
    }
    if (index > start) steps.push(part(start, index));
    steps.push({ kind: 'clear', room, name: realm.roomName(room), monsters });
    cost += tuning().world.fightCost;
    start = index;
  }
  // Unsplit, the walk is the route whole, with its hazards and its alternatives.
  steps.push(start === 0 ? { kind: 'walk', route } : part(start, route.steps.length));
  return { kind: 'leg', steps, cost };
}

/** A fight that stops the plan, or null where this character wins it. */
function refusedFight(
  odds: FightOdds,
  monster: string,
  item: PlannedItem | null
): PlanRefusal | null {
  switch (odds.kind) {
    case 'win':
      return null;
    case 'lose':
      return { kind: 'fight', item, monster, survives: odds.survives };
    case 'unread':
      return { kind: 'odds-unread', item, monster };
    default: {
      const never: never = odds;
      return never;
    }
  }
}

/** How telling a refusal is, so the one said for an item is the most useful. */
function weight(refusal: PlanRefusal): number {
  switch (refusal.kind) {
    case 'fight':
    case 'odds-unread':
    case 'purse':
      return 3;
    case 'out-of-reach':
      return 2;
    case 'no-way':
      return 1;
    case 'no-source':
      return 0;
    default: {
      const never: never = refusal;
      return never;
    }
  }
}

/** The step that gets the item at a source. */
function actionAt(source: ItemSource, item: PlannedItem): PlanStep {
  switch (source.kind) {
    case 'buy':
      return { kind: 'buy', item, room: source.room };
    case 'ask':
      return { kind: 'ask', item, room: source.room, say: source.say };
    case 'kill':
      return {
        kind: 'kill',
        item,
        monster: source.monster,
        room: source.room,
        ...(source.summon === undefined ? {} : { summon: source.summon })
      };
    default: {
      const never: never = source;
      return never;
    }
  }
}

export function plan(
  realm: PlanRealm,
  oracle: NavigationOracle,
  from: RoomId,
  to: RoomId,
  traveller: Traveller,
  options: RouteOptions = {}
): Plan {
  const direct = realm.route(from, to, traveller, options);
  return planAfter(realm, oracle, direct, from, to, traveller);
}

/**
 * The walk from one room to another with what is held now: the direct route,
 * where the plan fetches nothing. A room on it that wants emptying is walked
 * into as any lair is, once the plan has weighed the fight there and it is
 * won. A plan that fetches first is no walk yet: refused, with the planned way
 * and its keys in order (`unlocks`) for whoever fetches them.
 */
export function leg(
  realm: PlanRealm,
  oracle: NavigationOracle,
  from: RoomId,
  to: RoomId,
  traveller: Traveller,
  options: RouteOptions = {}
): Route {
  const direct = realm.route(from, to, traveller, options);
  const made = planAfter(realm, oracle, direct, from, to, traveller);
  if (made.kind === 'refused') return refusedLeg(direct, planRefusalsWords(made.refusals, t));
  const keyed = keyedRoute(made);
  if (keyed !== null) return { ...refusedLeg(direct, noWayWords(direct)), unlocks: keyed };
  // Fetching nothing, the plan walked the direct route as it was. For a
  // reader, the way round what the player keeps out of is planned as a walk
  // too, and a way through a door the walk went round is weighed.
  const keptOut = direct.keptOut;
  const round = keptOut?.round.blocked === true ? leg(realm, oracle, from, to, traveller) : null;
  const offered =
    options.alternatives === true && direct.keysAhead === true
      ? keyedOffer(realm, oracle, from, to, traveller, direct)
      : null;
  if (round === null && offered === null) return direct;
  return {
    ...direct,
    ...(round === null || keptOut === undefined ? {} : { keptOut: { ...keptOut, round } }),
    ...(offered === null ? {} : { unlocks: offered })
  };
}

/** A plan that fetches, as one route with its keys in order (`Route.needs`); null for a walk. */
function keyedRoute(made: Extract<Plan, { kind: 'plan' }>): Route | null {
  const needs = made.steps.flatMap((step) => (isFetch(step) ? [step.item] : []));
  if (needs.length === 0) return null;
  return {
    steps: made.steps.flatMap((step) => (step.kind === 'walk' ? step.route.steps : [])),
    cost: made.cost,
    blocked: false,
    needs
  };
}

/**
 * The way through doors a walkable route went round, where fetching their
 * keys and walking through beats it by `alternativeMinSteps`, the fetches
 * priced as the plan walks them (todo 805: 155 steps round against one
 * through the black star key's door).
 */
function keyedOffer(
  realm: PlanRealm,
  oracle: NavigationOracle,
  from: RoomId,
  to: RoomId,
  traveller: Traveller,
  direct: Route
): Route | null {
  const { alternativeMinSteps } = tuning().world;
  const beat = direct.cost - alternativeMinSteps;
  if (beat <= 0) return null;
  // Bounded by what would have to be beaten: the search expands only rooms the margin leaves in.
  const held = wayHolding(realm, from, to, traveller, realm.keysNamed(), beat);
  if (held === null || held.needs.length === 0) return null;
  // Never a way through a lair expected to kill, nor the direct route's own rooms again.
  const { way } = held;
  if (way.steps.some((step) => step.deadly === true)) return null;
  const same =
    way.steps.length === direct.steps.length &&
    way.steps.every((step, index) => step.to === direct.steps[index]?.to);
  if (same) return null;
  const made = planKeys(realm, oracle, from, to, traveller, held.needs);
  if (made.kind === 'refused' || made.cost > beat) return null;
  return keyedRoute(made);
}

/**
 * A walk refused for `reason`, keeping beside it what the router found: why
 * it was refused, or the walls a walked way crosses, which the reason names.
 */
function refusedLeg(direct: Route, reason: string): Route {
  const blocks = direct.blocked ? direct.blocks : direct.walls;
  return {
    steps: [],
    cost: 0,
    blocked: true,
    reason,
    ...(blocks === undefined ? {} : { blocks })
  };
}

/** The plan once the direct way is known. */
function planAfter(
  realm: PlanRealm,
  oracle: NavigationOracle,
  direct: Route,
  from: RoomId,
  to: RoomId,
  traveller: Traveller
): Plan {
  if (walkable(direct)) return finish(realm, oracle, from, to, traveller, [], 0, direct);
  const needs = keysWanted(realm, from, to, traveller, direct);
  if (needs.length === 0) return { kind: 'refused', refusals: [noWay(direct)] };
  return planKeys(realm, oracle, from, to, traveller, needs);
}

/** The plan that fetches these keys, cheapest first, else in every order of a few. */
function planKeys(
  realm: PlanRealm,
  oracle: NavigationOracle,
  from: RoomId,
  to: RoomId,
  traveller: Traveller,
  needs: readonly PlannedItem[]
): Plan {
  const greedy = acquire(realm, oracle, from, to, traveller, needs, null);
  if (greedy.kind === 'plan' || needs.length > ORDERS_TRIED) return greedy;
  /*
   * The cheapest key first can lead past a one-way move that strands the next
   * one: with a few keys, every order is tried before the way is refused.
   */
  for (const order of orders(needs)) {
    const fixed = acquire(realm, oracle, from, to, traveller, order, order);
    if (fixed.kind === 'plan') return fixed;
  }
  return greedy;
}

/** How many keys a plan tries every order of, when the cheapest-first order fails. */
const ORDERS_TRIED = 3;

/** Every order of a few items. */
function orders(items: readonly PlannedItem[]): PlannedItem[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    orders([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest])
  );
}

/**
 * Fetches every wanted item, from where each can be had holding what is held
 * by then, then walks on. `order` fixes which item comes next; without it the
 * cheapest to get comes next. The pack keeps the traveller's own `packKnown`:
 * a key planned is held for certain, and the rest of the pack is no better
 * known for it.
 */
function acquire(
  realm: PlanRealm,
  oracle: NavigationOracle,
  from: RoomId,
  to: RoomId,
  traveller: Traveller,
  needs: readonly PlannedItem[],
  order: readonly PlannedItem[] | null
): Plan {
  const held = [...(traveller.keys ?? [])];
  let at = from;
  let cost = 0;
  const steps: PlanStep[] = [];
  let wanted: PlannedItem[] = [...needs];
  while (wanted.length > 0) {
    const holding: Traveller = { ...traveller, keys: [...held] };
    const why = new Map<number, PlanRefusal>();
    const refuse = (refusal: PlanRefusal & { item: PlannedItem }): void => {
      const known = why.get(refusal.item.id);
      if (known === undefined || weight(refusal) > weight(known)) why.set(refusal.item.id, refusal);
    };
    // Every source priced with one sweep; the full leg is planned only for the
    // cheapest that this character can have, in price order.
    const candidates: Array<{ item: PlannedItem; source: ItemSource; price: number }> = [];
    // In a fixed order, the item at the position of how many are fetched so far.
    const fetched = needs.length - wanted.length;
    const next = order === null ? wanted : wanted.filter((item) => item.id === order[fetched]?.id);
    for (const item of next) {
      const sources = realm.sources(item.id);
      if (sources.length === 0) refuse({ kind: 'no-source', item });
      const reach = realm.sweep(at, new Set(sources.map((source) => source.room)), holding);
      for (const source of sources) {
        const priced = source.room === at ? { cost: 0 } : reach.get(source.room);
        if (priced === undefined || priced.cost >= tuning().world.wallCost) {
          refuse({ kind: 'out-of-reach', item });
          continue;
        }
        const lost = fightsOf(source)
          .map((monster) => refusedFight(oracle.fight(monster, source.room), monster, item))
          .find((refusal) => refusal !== null);
        if (lost !== undefined && lost !== null) {
          refuse({ ...lost, item });
          continue;
        }
        if (source.kind === 'buy' && oracle.affords(item.id, source.room) === false) {
          refuse({ kind: 'purse', item });
          continue;
        }
        const price = priced.cost + fightsOf(source).length * tuning().world.fightCost;
        candidates.push({ item, source, price });
      }
    }
    candidates.sort((a, b) => a.price - b.price);
    let best: {
      item: PlannedItem;
      source: ItemSource;
      leg: Extract<Leg, { kind: 'leg' }>;
      price: number;
    } | null = null;
    for (const candidate of candidates) {
      const leg = walk(realm, oracle, at, candidate.source.room, holding);
      if (leg.kind === 'leg') {
        const fights = fightsOf(candidate.source).length * tuning().world.fightCost;
        best = { ...candidate, leg, price: leg.cost + fights };
        break;
      }
      // A fight in the way is said as the fight; a way that is not there is out of reach.
      const blocking = leg.refusal;
      if (blocking.kind === 'fight' || blocking.kind === 'odds-unread') {
        refuse({ ...blocking, item: candidate.item });
      } else refuse({ kind: 'out-of-reach', item: candidate.item });
    }
    if (best === null) {
      return {
        kind: 'refused',
        refusals: wanted.map((item) => why.get(item.id) ?? { kind: 'out-of-reach', item })
      };
    }
    const chosen = best;
    steps.push(...chosen.leg.steps, actionAt(chosen.source, chosen.item));
    cost += chosen.price;
    held.push(chosen.item.id);
    at = chosen.source.room;
    wanted = wanted.filter((item) => item.id !== chosen.item.id);
  }
  return finish(realm, oracle, at, to, { ...traveller, keys: held }, steps, cost);
}

/** The last walk, holding everything fetched; `known` where the router already answered it. */
function finish(
  realm: PlanRealm,
  oracle: NavigationOracle,
  from: RoomId,
  to: RoomId,
  traveller: Traveller,
  steps: PlanStep[],
  cost: number,
  known?: Route
): Plan {
  const last = walk(realm, oracle, from, to, traveller, known);
  if (last.kind === 'refused') return { kind: 'refused', refusals: [last.refusal] };
  return { kind: 'plan', steps: [...steps, ...last.steps], cost: cost + last.cost };
}
