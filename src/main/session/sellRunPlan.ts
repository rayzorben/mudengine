/**
 * The Sell face's rows and its plan (`shared/sellRun.ts`). A row is a name
 * carried unworn or lying in the room, with what one pays and the nearest
 * counter whose shelf lists it (`SellCommand` buys only its shelf). The plan
 * is rounds: the floor items the free weight holds are picked up, then every
 * counter taking anything carried is visited in the order the navigation
 * engine finds shortest (`tour`, by moves), closing at the floor's room while
 * anything still lies there. Each leg is routed one per turn, since a route
 * is an A* on the socket's thread.
 */
import { t } from '../app/i18n';
import { nextTurn } from '../app/nextTurn';
import { tuning } from '../app/tuning';
import { countThatFits } from '../../shared/carrying';
import type { CharacterState } from '../../shared/character';
import { soldForCopper } from '../../shared/coins';
import { entityNumber, type ItemEntity } from '../../shared/entities';
import { sameItem } from '../../shared/items';
import type { QuestKeep } from '../../shared/questKeep';
import type {
  SellChoice,
  SellFrom,
  SellItem,
  SellKept,
  SellPick,
  SellRunPlan,
  SellStop
} from '../../shared/sellRun';
import { roomAddress, roomId, type RoomId } from '../../shared/world';
import { tour } from '../world/navigation/tour';
import type { WorldGraph } from '../world/WorldGraph';
import type { Errands } from './Errands';
import { legOf } from './gearTripPlan';
import { ERRAND_LEG } from './Travel';

export interface SellPlanParts {
  world(): Pick<WorldGraph, 'stockingPlaces' | 'item' | 'byId' | 'sweepTo'> | undefined;
  errands: Pick<Errands, 'routeBetween' | 'travellerNow'>;
  state(): CharacterState;
  /** What an unfinished quest still needs, which is never sold (todo 52). */
  kept: QuestKeep;
}

type World = NonNullable<ReturnType<SellPlanParts['world']>>;

/** A name with every copy of it that may go: the unworn ones carried, or the pile. */
interface Pile {
  name: string;
  from: SellFrom;
  count: number;
  thing: ItemEntity;
}

/** The pack's unworn items and the room's floor, open and searched, a pile a name. */
function piles(state: CharacterState): Pile[] {
  const found: Pile[] = [];
  const add = (thing: ItemEntity, from: SellFrom, count: number): void => {
    const pile = found.find((each) => each.from === from && sameItem(each.name, thing.name));
    if (pile === undefined) found.push({ name: thing.name, from, count, thing });
    else pile.count += count;
  };
  // A worn copy is not for sale: `sell` takes an unworn one first and the worn one after.
  for (const item of state.inventory.items) if (!item.equipped) add(item, 'pack', 1);
  for (const item of [...state.room.items, ...state.room.hidden]) {
    add(item, 'floor', item.count ?? 1);
  }
  return found;
}

/** A pile as the realm prices it, or why it cannot be sold. */
function priced(
  pile: Pile,
  world: World,
  parts: SellPlanParts,
  charm: number | null
): SellItem | { kept: SellKept; quest?: string } {
  if (pile.thing.gettable === false) return { kept: 'fixed' };
  const id = entityNumber(pile.thing);
  if (id === null) {
    return { kept: (pile.thing.ids?.length ?? 0) > 1 ? 'several-rows' : 'unknown-row' };
  }
  const quest = parts.kept.wantedBy(pile.thing);
  if (quest !== null) return { kept: 'quest', quest };
  const row = world.item(id);
  if (row?.price === undefined || row.currency === undefined) return { kept: 'unpriced' };
  const copper = soldForCopper(row.price, row.currency, charm);
  if (copper <= 0) return { kept: 'unpriced' };
  const weight = pile.thing.encumbrance ?? row.encumbrance ?? null;
  return { name: pile.name, item: id, count: pile.count, copper, weight };
}

/** Every name that could be picked, with what one pays and the nearest counter taking it. */
export function sellChoices(parts: SellPlanParts): SellChoice[] {
  const state = parts.state();
  const world = parts.world();
  const here = roomAddress(state.room);
  if (world === undefined || here === null) return [];
  const rows = piles(state).map((pile) => ({
    pile,
    item: priced(pile, world, parts, state.progress.charm)
  }));
  const ids = rows.flatMap(({ item }) => ('kept' in item ? [] : [item.item]));
  const places =
    ids.length === 0
      ? []
      : world.stockingPlaces(
          [...new Set(ids)],
          here,
          null,
          parts.errands.travellerNow(state),
          true
        );
  return rows.map(({ pile, item }): SellChoice => {
    const row = { name: pile.name, from: pile.from, count: pile.count };
    if ('kept' in item) return { ...row, copper: null, shop: null, moves: null, ...item };
    const nearest = places
      .filter((place) => place.item === item.item)
      .sort((a, b) => a.moves - b.moves)[0];
    return nearest === undefined
      ? { ...row, copper: item.copper, shop: null, moves: null, kept: 'no-counter' }
      : { ...row, copper: item.copper, shop: nearest.shop, moves: nearest.moves, kept: null };
  });
}

/** The picks as items to carry off and items to pick up, and those that cannot go. */
function wanted(
  parts: SellPlanParts,
  world: World,
  picks: readonly SellPick[]
): { pack: SellItem[]; floor: SellItem[]; left: SellRunPlan['left'] } {
  const state = parts.state();
  const all = piles(state);
  const pack: SellItem[] = [];
  const floor: SellItem[] = [];
  const left: SellRunPlan['left'] = [];
  for (const pick of picks) {
    const pile = all.find((each) => each.from === pick.from && sameItem(each.name, pick.name));
    if (pile === undefined) {
      left.push({ name: pick.name, why: pick.from === 'pack' ? 'not-carried' : 'not-here' });
      continue;
    }
    const item = priced(pile, world, parts, state.progress.charm);
    if ('kept' in item) left.push({ name: pick.name, why: item.kept });
    else
      (pick.from === 'pack' ? pack : floor).push({
        ...item,
        count: Math.min(pick.count, pile.count)
      });
  }
  return { pack, floor, left };
}

/** The plan for the card's picks, the floor being the room stood in. */
export async function planSellRun(
  parts: SellPlanParts,
  picks: readonly SellPick[]
): Promise<SellRunPlan> {
  const world = parts.world();
  const here = roomAddress(parts.state().room);
  if (world === undefined || here === null) return planRounds(parts, [], [], here, []);
  if (picks.length === 0) {
    return { ...EMPTY, from: here, refusal: t('cards.sell.nothingPicked') };
  }
  const { pack, floor, left } = wanted(parts, world, picks);
  return planRounds(parts, pack, floor, here, left);
}

const EMPTY: SellRunPlan = { from: '', stops: [], moves: 0, copper: 0, rounds: 0, left: [] };

type Unrouted =
  | Omit<Extract<SellStop, { kind: 'floor' }>, 'leg'>
  | Omit<Extract<SellStop, { kind: 'shop' }>, 'leg'>;

/**
 * Rounds from where the character stands: `carried` is sold in the first,
 * `floor` lies in `floorRoom` and is picked up as the weight allows. A run
 * under way plans its later rounds again through this, with what its takes
 * left behind.
 */
export async function planRounds(
  parts: SellPlanParts,
  carried: readonly SellItem[],
  floor: readonly SellItem[],
  floorRoom: RoomId | null,
  kept: SellRunPlan['left'] = []
): Promise<SellRunPlan> {
  const state = parts.state();
  const here = roomAddress(state.room);
  const world = parts.world();
  const empty: SellRunPlan = { ...EMPTY, from: here ?? '', left: [...kept] };
  if (world === undefined) return { ...empty, refusal: t('session.loop.noRealmData') };
  if (here === null) return { ...empty, refusal: t('session.loop.unknownRoom') };
  const { exactStops, counters, maxRounds } = tuning().sellRun;
  const left = empty.left;
  const stops: Unrouted[] = [];
  const lying = floor.map((item) => ({ ...item }));
  let selling = carried.map((item) => ({ ...item }));
  // The weight as the rounds move it; an unread pack or an unweighed item caps nothing.
  let load = state.inventory.encumbrance;
  let at: RoomId = here;
  let rounds = 0;

  while (rounds < maxRounds && (selling.length > 0 || lying.some((item) => item.count > 0))) {
    const round = rounds + 1;
    // The most valuable first, so what the weight leaves for later is worth least.
    const takes: SellItem[] = [];
    let carrying = load;
    for (const item of [...lying].sort((a, b) => b.copper - a.copper)) {
      if (floorRoom === null || item.count === 0) continue;
      const fits = countThatFits(carrying, state.inventory.encumbranceMax, item.weight);
      const count = fits === null ? item.count : Math.min(item.count, fits);
      if (count === 0) continue;
      takes.push({ ...item, count });
      if (carrying !== null && item.weight !== null) carrying += count * item.weight;
    }
    const offered = [...selling, ...takes];
    // Nothing fits and nothing carried sells to make room: the rest stays where it lies.
    if (offered.length === 0) break;

    await nextTurn();
    const takenOf = (item: SellItem): number =>
      takes.find((take) => take.item === item.item)?.count ?? 0;
    const back = lying.some((item) => item.count > takenOf(item)) ? floorRoom : null;
    const from = takes.length > 0 && floorRoom !== null ? floorRoom : at;
    const limits = { exactStops, counters };
    const { sold, unplaced } = counterStops(world, parts, from, offered, back, round, limits);
    if (unplaced.length > 0) {
      // No shop reached from here buys it, so it is not picked up; the round is worked out without it.
      const gone = new Set<number>();
      for (const { item, why } of unplaced) {
        // A row picked from the pack and from the floor is left out once.
        if (!gone.has(item.item)) left.push({ name: item.name, why });
        gone.add(item.item);
      }
      selling = selling.filter((item) => !gone.has(item.item));
      for (const item of lying) if (gone.has(item.item)) item.count = 0;
      continue;
    }
    if (takes.length > 0 && floorRoom !== null) {
      const place = nameOf(world, floorRoom);
      stops.push({ kind: 'floor', round, room: floorRoom, place, items: takes });
      for (const item of lying) item.count -= takenOf(item);
    }
    stops.push(...sold);
    // Everything offered is sold by the round's end, and its weight with it.
    load = offered.reduce(
      (weight, item) =>
        weight === null || item.weight === null ? weight : weight - item.count * item.weight,
      carrying
    );
    at = sold[sold.length - 1]!.room as RoomId;
    selling = [];
    rounds = round;
  }
  // Past the last round allowed the rest is left for another sale; short of it, nothing made the room.
  const why = rounds >= maxRounds ? 'too-many-rounds' : 'too-heavy';
  for (const item of lying) if (item.count > 0) left.push({ name: item.name, why });
  if (stops.length === 0) {
    return {
      ...empty,
      left,
      refusal: left.length > 0 ? t('cards.sell.nothingSells') : t('cards.sell.nothingPicked')
    };
  }

  // Each leg as the walk will plan it, one per turn.
  const planned: SellStop[] = [];
  let from: RoomId = here;
  let moves = 0;
  for (const stop of stops) {
    const to = stop.room as RoomId;
    if (to === from) {
      planned.push({ ...stop, leg: { ...STANDING } } as SellStop);
      continue;
    }
    await nextTurn();
    const leg = legOf(parts.errands.routeBetween(from, to, ERRAND_LEG.kind));
    moves += leg.steps ?? 0;
    planned.push({ ...stop, leg } as SellStop);
    from = to;
  }
  const copper = planned.reduce(
    (sum, stop) =>
      stop.kind === 'shop'
        ? sum + stop.items.reduce((paid, item) => paid + item.copper * item.count, 0)
        : sum,
    0
  );
  return { ...empty, stops: planned, moves, copper, rounds, left };
}

/** A stop in the room already stood in. */
const STANDING = { steps: 0, fights: [], hazards: [], walls: [], needs: [], blocked: null };

function nameOf(world: World, room: RoomId): string {
  return world.byId(room)?.name ?? room;
}

/**
 * One round's counters in walking order, everything a counter takes sold in
 * the one stop, and the items no counter reached from here takes.
 */
function counterStops(
  world: World,
  parts: SellPlanParts,
  from: RoomId,
  selling: readonly SellItem[],
  back: RoomId | null,
  round: number,
  limits: { exactStops: number; counters: number }
): {
  sold: Array<Extract<Unrouted, { kind: 'shop' }>>;
  unplaced: Array<{ item: SellItem; why: 'no-counter' | 'unreachable' }>;
} {
  const traveller = parts.errands.travellerNow(parts.state());
  const ids = [...new Set(selling.map((item) => item.item))];
  const places = world.stockingPlaces(ids, from, null, traveller, true);
  const things: Array<{ item: SellItem; rooms: Map<RoomId, string> }> = [];
  const unplaced: Array<{ item: SellItem; why: 'no-counter' | 'unreachable' }> = [];
  for (const item of selling) {
    const rooms = new Map<RoomId, string>();
    for (const place of places) {
      if (place.item === item.item) rooms.set(roomId(place.map, place.room), place.shop);
    }
    if (rooms.size === 0) unplaced.push({ item, why: 'no-counter' });
    else things.push({ item, rooms });
  }
  if (unplaced.length > 0 || things.length === 0) return { sold: [], unplaced };
  const order = tour(
    world,
    from,
    {
      things: things.map((thing) => [...thing.rooms.keys()]),
      places: limits.counters,
      exact: limits.exactStops,
      end: back,
      by: 'moves'
    },
    traveller
  );
  // No order at all is no way to any of them.
  const unreached = order === null ? things.map((_, index) => index) : order.unreached;
  if (order === null || unreached.length > 0) {
    const unreachable = unreached.map((index) => ({
      item: things[index]!.item,
      why: 'unreachable' as const
    }));
    return { sold: [], unplaced: unreachable };
  }
  const stops: Array<Extract<Unrouted, { kind: 'shop' }>> = [];
  for (const visit of order.stops) {
    const thing = things[visit.thing]!;
    const stop = stops.find((each) => each.room === visit.room);
    // One name from the pack and from the floor is one sale of both counts.
    const same = stop?.items.find((item) => item.item === thing.item.item);
    if (same !== undefined) same.count += thing.item.count;
    else if (stop !== undefined) stop.items.push({ ...thing.item });
    else {
      stops.push({
        kind: 'shop',
        round,
        room: visit.room,
        place: nameOf(world, visit.room),
        shop: thing.rooms.get(visit.room) ?? nameOf(world, visit.room),
        items: [{ ...thing.item }]
      });
    }
  }
  return { sold: stops, unplaced: [] };
}
