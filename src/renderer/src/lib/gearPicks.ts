/**
 * The Gear card's arithmetic: the cash a budget can reach, what it buys per
 * slot (`withinBudget`, shared with the planner extension), the player's own
 * picks laid over that, and what the picks cost. Pure, so the slider redraws
 * without asking main.
 */
import { t } from './i18n';
import { bankedCopper } from '@shared/coins';
import type { GearPick } from '@shared/gearTrip';
import { withinBudget } from '@shared/gearWorth';
import type { GearChoice, GearChoices, GearSlot } from '@shared/upgrades';

/** A copper figure as the card says it. */
export function copperWords(value: number): string {
  return t('cards.gear.copper', { copper: value.toLocaleString() });
}

/** How many picks have no price, said as a count; empty where none. */
export function unpricedWords(count: number): string {
  if (count === 0) return '';
  return count === 1
    ? t('cards.gear.unpricedCount.one')
    : t('cards.gear.unpricedCount.many', { count });
}

/** The cash a budget can reach: the purse and every vault on record; null where neither is read. */
export function cashAt(
  purse: number | null,
  banks: ReadonlyArray<{ copper: number }>
): number | null {
  if (purse === null && banks.length === 0) return null;
  return (purse ?? 0) + bankedCopper(banks);
}

/** A sold item with a price, as the budget weighs it. */
type Buyable = GearChoice & { copper: number };

function buyable(slots: readonly GearSlot[]): Buyable[] {
  return slots.flatMap((slot) =>
    slot.items.flatMap((item) => (item.charged === null ? [] : [{ ...item, copper: item.charged }]))
  );
}

/**
 * How many items a slot can take in one trip: its free places, and one more
 * that goes on in place of the weakest worn. The ranking weighs an item only
 * against the weakest, so a second replacement is never offered.
 */
export function roomFor(slot: Pick<GearSlot, 'places' | 'free'>): number {
  return Math.min(slot.places, slot.free + 1);
}

/** What `budget` buys, by slot: each slot's items, at most `roomFor` it. */
export function basketOf(choices: GearChoices, budget: number): Map<string, GearChoice[]> {
  const places = new Map(choices.slots.map((slot) => [slot.slot, roomFor(slot)]));
  const basket = new Map<string, GearChoice[]>();
  for (const item of withinBudget(
    buyable(choices.slots),
    budget,
    (slot) => places.get(slot) ?? 1
  )) {
    basket.set(item.slot, [...(basket.get(item.slot) ?? []), item]);
  }
  return basket;
}

/** The player's picks per slot by item row; a slot not named takes the basket's. */
export type PickOverrides = Readonly<Record<string, readonly number[]>>;

/** What each slot buys: the player's pick where there is one, else the basket's. */
export function picksOf(
  choices: GearChoices,
  basket: ReadonlyMap<string, readonly GearChoice[]>,
  overrides: PickOverrides
): Map<string, GearChoice[]> {
  const picked = new Map<string, GearChoice[]>();
  for (const slot of choices.slots) {
    const ids = overrides[slot.slot];
    const items =
      ids === undefined
        ? [...(basket.get(slot.slot) ?? [])]
        : ids.flatMap((id) => slot.items.filter((item) => item.item === id));
    if (items.length > 0) picked.set(slot.slot, items);
  }
  return picked;
}

/** The copper the picks cost, and how many have no price. */
export function costOf(picked: ReadonlyMap<string, readonly GearChoice[]>): {
  copper: number;
  unpriced: number;
  count: number;
} {
  let copper = 0;
  let unpriced = 0;
  let count = 0;
  for (const items of picked.values()) {
    for (const item of items) {
      count += 1;
      if (item.charged === null) unpriced += 1;
      else copper += item.charged;
    }
  }
  return { copper, unpriced, count };
}

/**
 * The picks as the trip asks for them, each with the worn item it goes on in
 * place of where every place of its kind is worn.
 */
export function tripPicks(
  choices: GearChoices,
  picked: ReadonlyMap<string, readonly GearChoice[]>
): GearPick[] {
  return choices.slots.flatMap((slot) =>
    (picked.get(slot.slot) ?? []).map((item, index) => ({
      item: item.item,
      name: item.name,
      // Past the free fingers of a ring kind, it goes on in place of the weakest.
      replaces: slot.places > 1 && index >= slot.free ? slot.worn : null
    }))
  );
}

/** A slot's pick toggled: one item in place of another, or up to `roomFor` the slot. */
export function toggled(slot: GearSlot, current: readonly number[], item: number): number[] {
  if (current.includes(item)) return current.filter((id) => id !== item);
  return [...current, item].slice(-roomFor(slot));
}
