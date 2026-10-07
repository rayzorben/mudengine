/**
 * A trip to buy gear: the vaults to draw from and the counters to buy at, in
 * the order the navigation engine walks them (`world/navigation/tour.ts`),
 * each leg with what it meets on the way. Planned by `session/gearTripPlan.ts`,
 * walked by `automation/GearTrip.ts`, drawn by the Gear card.
 */
import type { PlanFight, RouteBlock, RouteHazard } from './world';

/** An item the player picked to buy. */
export interface GearPick {
  item: number;
  name: string;
  /** The weakest worn it goes on in place of, where its kind is full (`WearWanted.replaces`). */
  replaces: string | null;
}

/** What the walk to a stop meets: shown, never a reason the plan is refused. */
export interface GearLeg {
  /** Steps the walk takes; null where no way was found. */
  steps: number | null;
  /** The fights the way takes, with this character's odds. */
  fights: PlanFight[];
  /** What the rooms on the way cast. */
  hazards: RouteHazard[];
  /** Doors on the way this character cannot pass. */
  walls: RouteBlock[];
  /** Keys a way through locked doors wants fetched first. */
  needs: Array<{ id: number; name: string }>;
  /** Why no way was found; null where one was. */
  blocked: string | null;
}

/** One item bought at a counter, at that counter's price for this character. */
export interface GearBuy extends GearPick {
  /** Copper, charm applied; null where the realm does not price it. */
  charged: number | null;
}

export type GearStop =
  | {
      kind: 'bank';
      /** `map/room`, and the room's own name. */
      room: string;
      place: string;
      bank: string;
      /** The vault's own `Shops` row, as the balance names it. */
      shop: number;
      /** What the record says is there, and what the trip draws, in copper. */
      held: number;
      withdraw: number;
      leg: GearLeg;
    }
  | {
      kind: 'shop';
      room: string;
      place: string;
      shop: string;
      items: GearBuy[];
      leg: GearLeg;
    };

/** Why a picked item has no stop. */
export type GearLeft = 'not-sold' | 'unreachable';

export interface GearTripPlan {
  /** `map/room` the plan was made from. */
  from: string;
  stops: GearStop[];
  /** The whole walk, in moves. */
  moves: number;
  /** Copper, charm applied, over every priced item. */
  owed: number;
  /** Items the realm does not price: `owed` is then a floor. */
  unpriced: number;
  /** The purse in copper; null where no listing has counted it. */
  purse: number | null;
  /** Copper still lacking once every vault stop has paid out; 0 where nothing is. */
  short: number;
  left: Array<{ name: string; why: GearLeft }>;
  /** Said instead of stops, where none could be planned. */
  refusal?: string;
}

/** Where a trip stands, for the card. */
export type GearTripStage = 'walking' | 'bank' | 'buying' | 'wearing' | 'ended';

export interface GearTripProgress {
  plan: GearTripPlan;
  /** The stop being walked to or served; `plan.stops.length` once past the last. */
  stop: number;
  stage: GearTripStage;
  /** Whether the legs are run (auto-combat off, steps between rounds) rather than walked. */
  run: boolean;
  bought: string[];
  /** Items a counter did not sell. */
  missed: string[];
  /** How the trip ended, where it has. */
  ended: string | null;
}

/** The items a plan buys, in walking order. */
export function planBuys(plan: GearTripPlan): GearBuy[] {
  return plan.stops.flatMap((stop) => (stop.kind === 'shop' ? stop.items : []));
}

/**
 * The card's picks, parsed at the boundary: every entry an item row, a name
 * and what it replaces, or null for the lot. Duplicates by row are kept once.
 */
export function asGearPicks(value: unknown): GearPick[] | null {
  if (!Array.isArray(value)) return null;
  const picks: GearPick[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { item, name, replaces } = entry as Record<string, unknown>;
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 0) return null;
    if (typeof name !== 'string' || name.trim().length === 0) return null;
    if (replaces !== null && typeof replaces !== 'string') return null;
    if (picks.some((pick) => pick.item === item)) continue;
    picks.push({ item, name, replaces });
  }
  return picks;
}
