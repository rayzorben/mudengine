/**
 * Selling what the player picked on the Inventory card's Sell face: items in
 * the pack and items on the floor of the room stood in. What fits is picked
 * up first; what does not waits in its room until a round of selling has made
 * the weight, and is gone back for, round after round. Each round's counters
 * are in the order the navigation engine walks them (`world/navigation/tour.ts`),
 * and everything a counter takes is sold there in one stop. Planned by
 * `session/sellRunPlan.ts`, walked by `automation/SellRun.ts`.
 */
import type { GearLeg } from './gearTrip';

/** Where a picked item is: carried, or on the floor of the room stood in. */
export type SellFrom = 'pack' | 'floor';

/**
 * Why a row cannot be picked: the realm has no row for the name, several rows
 * share it, the row states no price, no counter's shelf lists it, a quest
 * not yet finished needs it, or nobody may pick it up.
 */
export type SellKept =
  'unknown-row' | 'several-rows' | 'unpriced' | 'no-counter' | 'quest' | 'fixed';

/** One name on the Sell face, with what selling one pays and where. */
export interface SellChoice {
  name: string;
  from: SellFrom;
  /** How many may be picked: the unworn copies carried, or the pile's count. */
  count: number;
  /** What one pays, in copper, charm counted; null where `kept` says why not. */
  copper: number | null;
  /** The nearest counter taking it, and the moves there. */
  shop: string | null;
  moves: number | null;
  kept: SellKept | null;
  /** The quest that needs it, for `kept: 'quest'`. */
  quest?: string;
}

/** A row's key on the face: the pack and the floor can hold one name each. */
export function sellKey(row: { name: string; from: SellFrom }): string {
  return `${row.from}:${row.name}`;
}

/** What the card sends: a name, where it is, and how many of it. */
export interface SellPick {
  name: string;
  from: SellFrom;
  count: number;
}

/** An item a stop takes or sells, by the realm's row. */
export interface SellItem {
  name: string;
  item: number;
  count: number;
  /** What one pays, in copper. */
  copper: number;
  /** What one weighs; null where the realm does not say. */
  weight: number | null;
}

interface SellStopBase {
  /** Which round of selling the stop belongs to, from 1. */
  round: number;
  /** `map/room`, and the room's own name. */
  room: string;
  place: string;
  items: SellItem[];
  leg: GearLeg;
}

export type SellStop =
  /** The room the picked floor items lie in: what fits now is picked up. */
  (SellStopBase & { kind: 'floor' }) | (SellStopBase & { kind: 'shop'; shop: string });

/** Why a picked item has no stop. */
export type SellLeft =
  SellKept | 'unreachable' | 'too-heavy' | 'too-many-rounds' | 'not-carried' | 'not-here';

export interface SellRunPlan {
  /** `map/room` the plan was made from. */
  from: string;
  stops: SellStop[];
  /** The whole walk, in moves. */
  moves: number;
  /** What every planned sale pays together, in copper. */
  copper: number;
  rounds: number;
  left: Array<{ name: string; why: SellLeft }>;
  /** Said instead of stops, where none could be planned. */
  refusal?: string;
}

export type SellRunStage = 'walking' | 'taking' | 'selling' | 'planning' | 'ended';

/** Where a run stands, for the card. */
export interface SellRunProgress {
  plan: SellRunPlan;
  /** The stop being walked to or served; `plan.stops.length` once past the last. */
  stop: number;
  stage: SellRunStage;
  sold: string[];
  /** Picked up off the floor. */
  taken: string[];
  /** Not sold: a counter did not take it, or the pack no longer held it. */
  missed: string[];
  /** How the run ended, where it has. */
  ended: string | null;
  /** True when the run served its last stop; `missed` lists what it could not sell. */
  done: boolean;
}

/** How many of everything a plan sells. */
export function planSales(plan: SellRunPlan): number {
  return plan.stops.reduce(
    (sum, stop) =>
      stop.kind === 'shop' ? sum + stop.items.reduce((n, item) => n + item.count, 0) : sum,
    0
  );
}

/**
 * The card's picks, parsed at the boundary: every entry a name, where it is
 * and a count of at least one, or null for the lot. A row picked twice is
 * kept once.
 */
export function asSellPicks(value: unknown): SellPick[] | null {
  if (!Array.isArray(value)) return null;
  const picks: SellPick[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { name, from, count } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || name.trim().length === 0) return null;
    if (from !== 'pack' && from !== 'floor') return null;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return null;
    if (picks.some((pick) => sellKey(pick) === sellKey({ name, from }))) continue;
    picks.push({ name, from, count });
  }
  return picks;
}
