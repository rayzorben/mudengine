/**
 * The better items the realm sells for each slot this character wears, and
 * where and for how much: `slotGear`'s ranking joined to the counters that
 * stock each item and the counter's price. What a planner offers to buy, and
 * what tells it that cash has reached something new.
 *
 * Only what is better than what is worn, and only what a counter sells: an
 * item that drops from a monster is not something cash can fetch. The best
 * per slot, and beside them the cheapest the character can wear now: the
 * best alone offered a level-10 character two weapons at 3.6M and 3.9M
 * copper and nothing it could buy (2026-10-01).
 */
import { USED_NOT_WORN, WORN_SLOT, WORN_SLOT_HOLDS } from '../../shared/items';
import type { CharacterState } from '../../shared/character';
import type { ItemEntity } from '../../shared/entities';
import type { GearOffer, SlotUpgrade } from '../../shared/upgrades';
import {
  meanBlow,
  type SlotFigures,
  type SlotGearRow,
  type SlotRanking
} from '../../shared/slotGear';
import { roomId, type BuyingPlace, type RoomId, type WorldItem } from '../../shared/world';
import { figuresOfItem, outranks, slotGear, type SlotAsker } from './slotGear';

export interface UpgradeRealm {
  itemsWornIn(worn: number): readonly WorldItem[];
  /** Every counter stocking any of the items, each saying which. One pair of sweeps. */
  stockingPlaces(items: readonly number[]): Array<BuyingPlace & { item: number }>;
  /** The counter's price in copper at that room, charm aside; null where it cannot be read. */
  priceAt(name: string, at: RoomId): number | null;
}

/** The slots worn for what they stop or swing. */
export const WEAR_SLOTS = Object.keys(WORN_SLOT)
  .map(Number)
  .filter((worn) => !USED_NOT_WORN.has(worn));

/** A row's figure: damage a round (or the mean blow) for a weapon, armour class otherwise. */
function figureOf(row: SlotGearRow): number | null {
  return row.damage === null ? row.ac : (row.perRound?.value ?? meanBlow(row.damage));
}

/** What is worn in each `Items.Worn` slot, by the realm's code the pack carries. */
export function wornBySlot(state: CharacterState): Map<number, ItemEntity[]> {
  const worn = new Map<number, ItemEntity[]>();
  for (const item of state.inventory.items) {
    if (!item.equipped || item.wornSlotCode === undefined) continue;
    worn.set(item.wornSlotCode, [...(worn.get(item.wornSlotCode) ?? []), item]);
  }
  return worn;
}

/** A carried item as a row of the slot: its own row where the list holds it, else its own figures. */
export function figuresOf(rows: readonly SlotGearRow[], item: ItemEntity): SlotFigures {
  const name = item.name.toLowerCase();
  return rows.find((each) => each.name.toLowerCase() === name) ?? figuresOfItem(item);
}

/** The weakest of what is worn in a slot, which an upgrade there replaces; null where none is. */
export function weakestWorn(
  rows: readonly SlotGearRow[],
  worn: readonly ItemEntity[],
  ranking: SlotRanking
): { item: ItemEntity; figures: SlotFigures } | null {
  const figures = outranks(ranking);
  let weakest: { item: ItemEntity; figures: SlotFigures } | null = null;
  for (const item of worn) {
    const own = figuresOf(rows, item);
    if (weakest === null || figures(own, weakest.figures) > 0) weakest = { item, figures: own };
  }
  return weakest;
}

/**
 * The rows better than what is worn: anything, where the slot has room for
 * one more (a second ring); else what gives strictly more than the weakest
 * worn there, which is what it would replace. A row only as good is not an
 * upgrade.
 */
function betterThan(
  rows: readonly SlotGearRow[],
  weakest: SlotFigures | null,
  free: number,
  ranking: SlotRanking
): SlotGearRow[] {
  if (free > 0 || weakest === null) return [...rows];
  return rows.filter((row) => versusWorn(ranking, row, weakest) < 0);
}

/**
 * How an item weighs against the weakest worn in its slot: negative where it
 * gives strictly more. A worn item the list does not rank is weighed by its
 * blow alone, as nothing reckons its round.
 */
export function versusWorn(ranking: SlotRanking, item: SlotFigures, worn: SlotFigures): number {
  const figures = outranks(ranking);
  return worn.perRound === null && item.perRound !== null
    ? figures({ ...item, perRound: null }, worn)
    : figures(item, worn);
}

/** The names of what the pack holds and does not wear: never bought again. */
function carriedUnworn(state: CharacterState): Set<string> {
  return new Set(
    state.inventory.items.filter((item) => !item.equipped).map((item) => item.name.toLowerCase())
  );
}

/**
 * Each slot's better items that a counter sells, best first, at most
 * `perSlot` of them, each at the counter least out of the way, and the
 * cheapest of them the character's level wears now where it is not already
 * among those.
 */
export function gearUpgrades(
  state: CharacterState,
  realm: UpgradeRealm,
  asker: SlotAsker,
  perSlot: number
): SlotUpgrade[] {
  const level = state.progress.level;
  const worn = wornBySlot(state);
  // An item the pack already holds is not bought again (2026-10-01: two leather belts, two cloth shoes).
  const carried = carriedUnworn(state);
  const slots: Array<{
    worn: number;
    gear: ReturnType<typeof slotGear>;
    better: SlotGearRow[];
    weakest: ItemEntity | null;
    free: number;
  }> = [];
  for (const code of WEAR_SLOTS) {
    const gear = slotGear(code, realm, asker);
    const wornHere = worn.get(code) ?? [];
    const free = Math.max(0, (WORN_SLOT_HOLDS[code] ?? 1) - wornHere.length);
    const weakest = weakestWorn(gear.rows, wornHere, gear.ranking);
    const better = betterThan(gear.rows, weakest?.figures ?? null, free, gear.ranking).filter(
      (row) => !carried.has(row.name.toLowerCase())
    );
    slots.push({ worn: code, gear, better, weakest: weakest?.item ?? null, free });
  }
  const wanted = [...new Set(slots.flatMap((slot) => slot.better.map((row) => row.id)))];
  const nearest = new Map<number, BuyingPlace>();
  for (const place of realm.stockingPlaces(wanted)) {
    const known = nearest.get(place.item);
    if (known === undefined || place.detour < known.detour) nearest.set(place.item, place);
  }
  const upgrades: SlotUpgrade[] = [];
  for (const { gear, better, weakest, free } of slots) {
    const sold: GearOffer[] = [];
    for (const row of better) {
      const place = nearest.get(row.id);
      if (place === undefined) continue;
      sold.push({
        item: row.id,
        name: row.name,
        figure: figureOf(row),
        ac: row.ac,
        dr: row.dr,
        minLevel: row.minLevel,
        shop: place.shop,
        at: { map: place.map, room: place.room },
        moves: place.moves,
        copper: realm.priceAt(row.name, roomId(place.map, place.room))
      });
    }
    const offers = sold.slice(0, perSlot);
    const cheapest = cheapestWearable(sold, level);
    if (cheapest !== null && !offers.includes(cheapest)) offers.push(cheapest);
    const current = weakest?.name ?? null;
    const wornRow = gear.rows.find((row) => row.name.toLowerCase() === current?.toLowerCase());
    if (offers.length === 0 && current === null) continue;
    upgrades.push({
      slot: gear.slot,
      worn: current,
      wornFigure: wornRow === undefined ? null : figureOf(wornRow),
      wornDr: wornRow?.dr ?? null,
      ranking: gear.ranking.by,
      free,
      offers
    });
  }
  return upgrades;
}

/** The cheapest priced offer a character of this level may wear; none while the level is unread. */
function cheapestWearable(offers: readonly GearOffer[], level: number | null): GearOffer | null {
  if (level === null) return null;
  let best: GearOffer | null = null;
  for (const offer of offers) {
    if (offer.copper === null || (offer.minLevel ?? 0) > level) continue;
    if (best === null || offer.copper < (best.copper ?? Infinity)) best = offer;
  }
  return best;
}
