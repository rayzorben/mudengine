/**
 * The arithmetic behind the supplies list, shared by the errand in main and
 * the Self card in the renderer so the two cannot count differently.
 */
import type { CharacterState } from './character';
import type { SupplyItem } from './config';
import { bareName } from './items';
import { nameAnswersTo } from './world';

/**
 * How many of `name` the pack holds, counted the way the server matches a
 * typed name (`nameAnswersTo`): `torch` finds every torch, lit or spare, and
 * `scroll of minor` finds the scroll. One per row, because the pack holds
 * instances — a listing's `2 torch` is already two rows.
 */
export function carriedCount(state: CharacterState, name: string): number {
  const typed = bareName(name);
  if (typed.length === 0) return 0;
  let count = 0;
  for (const item of state.inventory.items) {
    if (nameAnswersTo(bareName(item.name), typed)) count += 1;
  }
  return count;
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
  return [...rest, { ...row, max: Math.max(row.min, row.max) }];
}
