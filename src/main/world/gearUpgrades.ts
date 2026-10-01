/**
 * The better items the realm sells for each slot this character wears, and
 * where and for how much: `slotGear`'s ranking joined to the counters that
 * stock each item and the counter's price. What the planner offers to buy,
 * and what tells it that cash has reached something new (todo 52).
 *
 * Only what is better than what is worn, and only what a counter sells: an
 * item that drops from a monster is not something cash can fetch.
 */
import { USED_NOT_WORN, WORN_SLOT } from '../../shared/items';
import type { CharacterState } from '../../shared/character';
import type { ItemEntity } from '../../shared/entities';
import type { GearOffer, SlotUpgrade } from '../../shared/konamiBrief';
import { meanBlow, type SlotGearRow } from '../../shared/slotGear';
import { roomId, type BuyingPlace, type RoomId, type WorldItem } from '../../shared/world';
import { slotGear, type SlotAsker } from './slotGear';

export interface UpgradeRealm {
  itemsWornIn(worn: number): readonly WorldItem[];
  /** Every counter stocking any of the items, each saying which. One pair of sweeps. */
  stockingPlaces(items: readonly number[]): Array<BuyingPlace & { item: number }>;
  /** The counter's price in copper at that room, charm aside; null where it cannot be read. */
  priceAt(name: string, at: RoomId): number | null;
}

/** The slots worn for what they stop or swing. */
const WEAR_SLOTS = Object.keys(WORN_SLOT)
  .map(Number)
  .filter((worn) => !USED_NOT_WORN.has(worn));

/** A row's figure: damage a round (or the mean blow) for a weapon, armour class otherwise. */
function figureOf(row: SlotGearRow): number | null {
  return row.damage === null ? row.ac : (row.perRound?.value ?? meanBlow(row.damage));
}

/** What is worn in each `Items.Worn` slot, by the realm's code the pack carries. */
function wornBySlot(state: CharacterState): Map<number, ItemEntity> {
  const worn = new Map<number, ItemEntity>();
  for (const item of state.inventory.items) {
    if (item.equipped && item.wornSlotCode !== undefined) worn.set(item.wornSlotCode, item);
  }
  return worn;
}

/**
 * The rows better than what is worn. Rows are best first, so that is what
 * comes before the worn one; an item the list does not hold (one this
 * character could not otherwise use, a unique) is weighed by its own figure,
 * the mean blow for a weapon and armour class otherwise.
 */
function betterThan(rows: readonly SlotGearRow[], worn: ItemEntity | undefined): SlotGearRow[] {
  if (worn === undefined) return [...rows];
  const name = worn.name.toLowerCase();
  const at = rows.findIndex((row) => row.name.toLowerCase() === name);
  if (at !== -1) return rows.slice(0, at);
  if (worn.weapon !== undefined) {
    const own = meanBlow({ min: worn.weapon.min, max: worn.weapon.max }) ?? 0;
    return rows.filter((row) => (meanBlow(row.damage) ?? 0) > own);
  }
  const own = worn.armour?.ac ?? 0;
  return rows.filter((row) => (row.ac ?? 0) > own);
}

/**
 * Each slot's better items that a counter sells, best first, at most
 * `perSlot` of them, each at the counter least out of the way.
 */
export function gearUpgrades(
  state: CharacterState,
  realm: UpgradeRealm,
  asker: SlotAsker,
  perSlot: number
): SlotUpgrade[] {
  const worn = wornBySlot(state);
  const slots: Array<{ worn: number; gear: ReturnType<typeof slotGear>; better: SlotGearRow[] }> =
    [];
  for (const code of WEAR_SLOTS) {
    const gear = slotGear(code, realm, asker);
    slots.push({ worn: code, gear, better: betterThan(gear.rows, worn.get(code)) });
  }
  const wanted = [...new Set(slots.flatMap((slot) => slot.better.map((row) => row.id)))];
  const nearest = new Map<number, BuyingPlace>();
  for (const place of realm.stockingPlaces(wanted)) {
    const known = nearest.get(place.item);
    if (known === undefined || place.detour < known.detour) nearest.set(place.item, place);
  }
  const upgrades: SlotUpgrade[] = [];
  for (const { worn: code, gear, better } of slots) {
    const offers: GearOffer[] = [];
    for (const row of better) {
      if (offers.length >= perSlot) break;
      const place = nearest.get(row.id);
      if (place === undefined) continue;
      const copper = realm.priceAt(row.name, roomId(place.map, place.room));
      offers.push({
        item: row.id,
        name: row.name,
        figure: figureOf(row),
        ac: row.ac,
        dr: row.dr,
        minLevel: row.minLevel,
        shop: place.shop,
        at: { map: place.map, room: place.room },
        moves: place.moves,
        copper
      });
    }
    const current = worn.get(code)?.name ?? null;
    const wornRow = gear.rows.find((row) => row.name.toLowerCase() === current?.toLowerCase());
    if (offers.length === 0 && current === null) continue;
    upgrades.push({
      slot: gear.slot,
      worn: current,
      wornFigure: wornRow === undefined ? null : figureOf(wornRow),
      wornDr: wornRow?.dr ?? null,
      ranking: gear.ranking.by,
      offers
    });
  }
  return upgrades;
}
