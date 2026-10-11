/**
 * The arithmetic behind the supplies list, shared by the errand in main and
 * the Self card in the renderer so the two cannot count differently.
 */
import type { CharacterState } from './character';
import type { SupplyItem } from './config';
import { bareName } from './items';
import { nameAnswersTo, type RoomId } from './world';

/**
 * How many of `name` the pack holds, counted the way the server matches a
 * typed name (`nameAnswersTo`): `torch` finds every torch, lit or spare, and
 * `scroll of minor` finds the scroll. One per row, because the pack holds
 * instances — a listing's `2 torch` is already two rows. The key ring counts
 * too: `i` lists keys on their own line (`2 black star key`), so a key row read
 * only from the carried list was never held and was picked up off every floor.
 */
export function carriedCount(state: CharacterState, name: string): number {
  const typed = bareName(name);
  if (typed.length === 0) return 0;
  let count = 0;
  for (const item of state.inventory.items) {
    if (nameAnswersTo(bareName(item.name), typed)) count += 1;
  }
  for (const key of state.inventory.keys) {
    if (nameAnswersTo(bareName(key), typed)) count += 1;
  }
  return count;
}

/** How many of a row to carry: its maximum, never under its minimum. */
export function stockCeiling(item: Pick<SupplyItem, 'min' | 'max'>): number {
  return Math.max(item.min, item.max);
}

/** The row on the list that names this item, by the same matching, or null. */
export function supplyFor(items: readonly SupplyItem[], name: string): SupplyItem | null {
  const typed = bareName(name);
  return items.find((item) => bareName(item.name) === typed) ?? null;
}

/**
 * The list with one row replaced, added or removed, by name.
 *
 * `null` removes; a row with a zero minimum is kept only if it names a shop,
 * because "keep none, buy none" is a row that does nothing — but a shop chosen
 * ahead of a minimum is a preference worth keeping.
 */
export function withSupply(
  items: readonly SupplyItem[],
  name: string,
  row: SupplyItem | null
): SupplyItem[] {
  const typed = bareName(name);
  const rest = items.filter((item) => bareName(item.name) !== typed);
  if (row === null) return rest;
  if (row.min <= 0 && row.max <= 0 && row.shop.length === 0) return rest;
  return [...rest, { ...row, max: stockCeiling(row) }];
}

/** Whether a row leaves the counter to the realm (todo 49): no shop and no room named. */
export function namesNoShop(item: Pick<SupplyItem, 'shop' | 'at'>): boolean {
  return item.at === null && item.shop.trim().length === 0;
}

/**
 * Where a supply row is bought, as the errand asks it (todo 49).
 *
 * `counter` is a shop to walk to: the row's own, or with none named the
 * nearest that sells the item, with how many moves away it is (null for a
 * named shop). `found` is a row no counter sells and a
 * monster drops, filled off the floor by `AutoLoot.stockingUp`. `nowhere` is
 * a row nothing sells or drops, said once. `refused` is a counter that cannot
 * be settled or reached now, tried again after `tuning.supplies.retryMs`.
 */
export type SupplyCounter =
  | { kind: 'counter'; room: RoomId; name: string; moves: number | null }
  | { kind: 'found' }
  | { kind: 'nowhere'; why: string }
  | { kind: 'refused'; why: string };

/** Each supply row's counter, by the row's name, as the Supplies face shows it. */
export type SupplyCounters = Readonly<Record<string, SupplyCounter>>;
