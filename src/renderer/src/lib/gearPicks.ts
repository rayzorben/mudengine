/**
 * The Gear card's arithmetic: the cash a budget can reach, what it buys per
 * slot (`withinBudget`, shared with the planner extension), the player's own
 * picks laid over that, and what the picks cost. Pure, so the slider redraws
 * without asking main.
 */
import { t } from './i18n';
import { bankedCopper } from '@shared/coins';
import type { GearPick } from '@shared/gearTrip';
import { withinBudget, type GearGain } from '@shared/gearWorth';
import { share } from '@shared/tally';
import type { GearChoice, GearChoices, GearSlot } from '@shared/upgrades';

/** A copper figure as the card says it. */
export function copperWords(value: number): string {
  return t('cards.gear.copper', { copper: value.toLocaleString() });
}

/** A track filled to `part` of `whole`, as a width; empty where the whole is nothing. */
export function widthOf(part: number, whole: number): string {
  return `${Math.min(100, (share(part, whole) ?? 0) * 100)}%`;
}

/** What an item adds, as the sheet says it; empty where nothing can be said. */
export function gainWords(gain: GearGain): string {
  const parts: string[] = [];
  if (gain.armourClass !== null && gain.armourClass !== 0) {
    parts.push(t('cards.gear.gainArmour', { ac: Math.round(gain.armourClass * 10) / 10 }));
  }
  if (gain.perRound !== null && gain.perRound !== 0) {
    parts.push(t('cards.gear.gainRound', { damage: Math.round(gain.perRound * 10) / 10 }));
  }
  return parts.join(' ');
}

/** Where an item comes from: the shop, else who drops it, else neither. */
export function sourceWords(item: GearChoice): string {
  if (item.sold !== null) {
    return item.counters > 1
      ? t('cards.gear.soldMore', { shop: item.sold.shop, more: item.counters - 1 })
      : t('cards.gear.sold', { shop: item.sold.shop });
  }
  if (item.droppedBy.length > 0) {
    return t('cards.gear.dropped', { monsters: item.droppedBy.slice(0, 3).join(', ') });
  }
  return t('cards.gear.nowhere');
}

/** A price, or that the realm states none. */
export function priceWords(charged: number | null): string {
  return charged === null ? t('cards.gear.unpriced') : copperWords(charged);
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

/**
 * The player's say over the suggestions: items chosen for a slot in place of
 * what the budget would buy there, and suggestions declined, keyed by
 * `declineKey`. A decline keeps its item on the card, so a click never swaps
 * what is under the pointer.
 */
export interface GearSay {
  chosen: Readonly<Record<string, readonly number[]>>;
  declined: ReadonlySet<string>;
}

export const NO_SAY: GearSay = { chosen: {}, declined: new Set() };

export function declineKey(slot: string, item: number): string {
  return `${slot}#${item}`;
}

/**
 * What each slot suggests: the items the player chose, paid for first, then
 * what the rest of the budget buys in the other slots (`withinBudget`), at
 * most `roomFor` a slot.
 */
export function suggestionsOf(
  choices: GearChoices,
  budget: number,
  chosen: GearSay['chosen']
): Map<string, GearChoice[]> {
  const suggested = new Map<string, GearChoice[]>();
  let fixed = 0;
  for (const slot of choices.slots) {
    const ids = chosen[slot.slot];
    if (ids === undefined) continue;
    const items = ids.flatMap((id) => slot.items.filter((item) => item.item === id));
    suggested.set(slot.slot, items);
    fixed += items.reduce((sum, item) => sum + (item.charged ?? 0), 0);
  }
  const open = choices.slots.filter((slot) => chosen[slot.slot] === undefined);
  const places = new Map(open.map((slot) => [slot.slot, roomFor(slot)]));
  for (const item of withinBudget(
    buyable(open),
    Math.max(0, budget - fixed),
    (slot) => places.get(slot) ?? 1
  )) {
    suggested.set(item.slot, [...(suggested.get(item.slot) ?? []), item]);
  }
  return suggested;
}

/** What the trip buys: the suggestions less what the player declined. */
export function buysOf(
  suggested: ReadonlyMap<string, readonly GearChoice[]>,
  declined: GearSay['declined']
): Map<string, GearChoice[]> {
  const buys = new Map<string, GearChoice[]>();
  for (const [slot, items] of suggested) {
    const kept = items.filter((item) => !declined.has(declineKey(slot, item.item)));
    if (kept.length > 0) buys.set(slot, kept);
  }
  return buys;
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
