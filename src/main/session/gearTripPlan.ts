/**
 * The plan for a gear trip (`shared/gearTrip.ts`): the counters selling each
 * picked item, and the vaults the purse needs first, put in the order the
 * navigation engine finds shortest (`tour`, by moves: the user asked that the
 * order not weigh survival), then every leg planned as the walk will plan it,
 * with the fights, hazards and doors it meets. Shown, never refused for them
 * (`mudengine-world` › *Survival never refuses a plan*). The legs are routed
 * one per turn, since a route is an A* on the socket's thread.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { CharacterState } from '../../shared/character';
import { chargedInCopper } from '../../shared/coins';
import type { GearBuy, GearLeg, GearPick, GearStop, GearTripPlan } from '../../shared/gearTrip';
import { roomAddress, roomId, type CashPlace, type RoomId, type Route } from '../../shared/world';
import { tour } from '../world/navigation/tour';
import type { WorldGraph } from '../world/WorldGraph';
import type { Errands } from './Errands';

export interface GearPlanParts {
  world(): Pick<WorldGraph, 'stockingPlaces' | 'cashPlaces' | 'byId' | 'sweepTo'> | undefined;
  errands: Pick<Errands, 'priceAt' | 'routeBetween' | 'travellerNow'>;
  state(): CharacterState;
}

/** A thing the tour visits: a vault to draw from, or an item to buy. */
type Thing =
  | { kind: 'cash'; vaults: CashPlace[]; withdraw: (place: CashPlace) => number }
  | { kind: 'item'; pick: GearPick; rooms: Map<RoomId, string> };

/** The plan from where the character stands; a plan with a `refusal` where none can be made. */
export async function planGearTrip(
  parts: GearPlanParts,
  picks: readonly GearPick[]
): Promise<GearTripPlan> {
  const state = parts.state();
  const here = roomAddress(state.room);
  const world = parts.world();
  const empty: GearTripPlan = {
    from: here ?? '',
    stops: [],
    moves: 0,
    owed: 0,
    unpriced: 0,
    purse: state.inventory.wealth,
    short: 0,
    left: []
  };
  if (world === undefined) return { ...empty, refusal: t('session.loop.noRealmData') };
  if (here === null) return { ...empty, refusal: t('session.loop.unknownRoom') };
  const { exactStops, counters } = tuning().gear;
  if (picks.length === 0) return { ...empty, refusal: t('cards.gear.trip.nothingPicked') };
  // As the character stands: no room run from is walked round (`GearTripPlanner.routeTo`).
  const traveller = parts.errands.travellerNow(state);
  const left: GearTripPlan['left'] = [];

  // Every counter selling each item, by room, with the shop's name.
  const sold = world.stockingPlaces(
    picks.map((pick) => pick.item),
    here,
    null,
    traveller
  );
  const things: Thing[] = [];
  for (const pick of picks) {
    const rooms = new Map<RoomId, string>();
    for (const place of sold) {
      if (place.item === pick.item) rooms.set(roomId(place.map, place.room), place.shop);
    }
    if (rooms.size === 0) left.push({ name: pick.name, why: 'not-sold' });
    else things.push({ kind: 'item', pick, rooms });
  }

  // What the nearest counters charge, the floor the vaults are asked for.
  const charm = state.progress.charm;
  const cheapestAt = (thing: Extract<Thing, { kind: 'item' }>): number | null => {
    let low: number | null = null;
    for (const room of thing.rooms.keys()) {
      const price = parts.errands.priceAt(thing.pick.name, room);
      if (price !== null && (low === null || price < low)) low = price;
    }
    return low === null ? null : chargedInCopper(low, charm);
  };
  const items = things.filter(
    (thing): thing is Extract<Thing, { kind: 'item' }> => thing.kind === 'item'
  );
  const floor = items.reduce((sum, thing) => sum + (cheapestAt(thing) ?? 0), 0);
  const purse = state.inventory.wealth;
  // An unread purse is not an empty one: no vault is walked to on its account.
  const shortfall = purse === null ? 0 : Math.max(0, floor - purse);
  let short = 0;
  if (shortfall > 0) {
    const drawn = vaultThings(world.cashPlaces(state.banks, 1, here, null, traveller), shortfall);
    things.unshift(...drawn.things);
    short = drawn.short;
  }

  const cash = new Set(things.flatMap((thing, index) => (thing.kind === 'cash' ? [index] : [])));
  const order = tour(
    world,
    here,
    {
      things: things.map((thing) =>
        thing.kind === 'cash'
          ? thing.vaults.map((vault) => roomId(vault.map, vault.room))
          : [...thing.rooms.keys()]
      ),
      places: counters,
      exact: exactStops,
      end: null,
      first: cash,
      by: 'moves'
    },
    traveller
  );
  for (const index of order?.unreached ?? []) {
    const thing = things[index]!;
    if (thing.kind === 'item') left.push({ name: thing.pick.name, why: 'unreachable' });
  }
  if (order === null || order.stops.length === 0) {
    return { ...empty, left, short, refusal: t('cards.gear.trip.noWay') };
  }

  // The stops in walking order, every item at one counter bought in one stop.
  const stops: Array<
    | Omit<Extract<GearStop, { kind: 'shop' }>, 'leg'>
    | Omit<Extract<GearStop, { kind: 'bank' }>, 'leg'>
  > = [];
  let owed = 0;
  let unpriced = 0;
  for (const visit of order.stops) {
    const thing = things[visit.thing]!;
    const place = world.byId(visit.room)?.name ?? visit.room;
    if (thing.kind === 'cash') {
      const vault = thing.vaults.find((each) => roomId(each.map, each.room) === visit.room)!;
      stops.push({
        kind: 'bank',
        room: visit.room,
        place,
        bank: vault.name,
        shop: vault.shop,
        held: vault.copper,
        withdraw: thing.withdraw(vault)
      });
      continue;
    }
    const price = parts.errands.priceAt(thing.pick.name, visit.room);
    const charged = price === null ? null : chargedInCopper(price, charm);
    if (charged === null) unpriced += 1;
    else owed += charged;
    const buy: GearBuy = { ...thing.pick, charged };
    const at = stops.find((stop) => stop.kind === 'shop' && stop.room === visit.room);
    if (at !== undefined && at.kind === 'shop') at.items.push(buy);
    else {
      stops.push({
        kind: 'shop',
        room: visit.room,
        place,
        shop: thing.rooms.get(visit.room) ?? place,
        items: [buy]
      });
    }
  }

  // Each leg as the walk will plan it, one per turn.
  const planned: GearStop[] = [];
  let from: RoomId = here;
  let moves = 0;
  for (const stop of stops) {
    await new Promise<void>((next) => setImmediate(next));
    const route = parts.errands.routeBetween(from, stop.room as RoomId, 'walk');
    const leg = legOf(route);
    moves += leg.steps ?? 0;
    planned.push({ ...stop, leg } as GearStop);
    from = stop.room as RoomId;
  }
  return { ...empty, stops: planned, moves, owed, unpriced, short, left };
}

/**
 * The vaults the trip draws from: any one that alone holds the shortfall,
 * the tour choosing among them, else the fullest in turn until it is met.
 * `short` is what the record says no vault holds.
 */
function vaultThings(
  vaults: readonly CashPlace[],
  shortfall: number
): { things: Thing[]; short: number } {
  const buffer = tuning().supplies.cashBuffer;
  const alone = vaults.filter((vault) => vault.copper >= shortfall);
  if (alone.length > 0) {
    return {
      things: [
        {
          kind: 'cash',
          vaults: alone,
          withdraw: (vault) => Math.min(vault.copper, shortfall + buffer)
        }
      ],
      short: 0
    };
  }
  const things: Thing[] = [];
  let need = shortfall;
  for (const vault of [...vaults].sort((a, b) => b.copper - a.copper)) {
    if (need <= 0 || vault.copper <= 0) break;
    things.push({ kind: 'cash', vaults: [vault], withdraw: (each) => each.copper });
    need -= vault.copper;
  }
  return { things, short: Math.max(0, need) };
}

/**
 * What a leg's route meets, for the card. A way walled by a door wants its
 * keys fetched first (`Route.unlocks`): that way's fights and keys are what
 * is shown, and the leg says it is not walked as it stands.
 */
function legOf(route: Route | string): GearLeg {
  if (typeof route === 'string') {
    return { steps: null, fights: [], hazards: [], walls: [], needs: [], blocked: route };
  }
  const way = route.blocked && route.unlocks !== undefined ? route.unlocks : route;
  return {
    steps: way.blocked ? null : way.steps.length,
    fights: way.fights ?? [],
    hazards: way.hazards ?? [],
    walls: way.walls ?? [],
    needs: way.needs ?? [],
    blocked: route.blocked ? (route.reason ?? t('automation.walk.refusalNoRoute')) : null
  };
}
