/**
 * What fills each of the paper doll's squares: the worn items in the inventory
 * (`i`), by the slot word printed after each (`(Head)`, `(Finger)`). A slot holding two
 * takes them in the order the server printed them. Pure.
 */
import type { CarriedItem, Inventory } from '@shared/character';
import { placesIn, wornOfWord } from '@shared/items';

export interface WornSlots {
  /** `code/place` (`DollSlot.id`) to the item there. */
  bySlot: ReadonlyMap<string, CarriedItem>;
  /** Worn, but under a word no slot has, or past a slot's places: shown under the doll, never dropped. */
  elsewhere: readonly CarriedItem[];
}

/** Null where nobody has listed the pack: every square is unknown then, not empty. */
export function wornSlotsOf(inventory: Inventory): WornSlots | null {
  if (inventory.listedAt === null) return null;
  const bySlot = new Map<string, CarriedItem>();
  const elsewhere: CarriedItem[] = [];
  for (const item of inventory.items) {
    if (!item.equipped) continue;
    const code = item.slot === null ? null : wornOfWord(item.slot);
    if (code === null) {
      elsewhere.push(item);
      continue;
    }
    let place = 0;
    while (place < placesIn(code) && bySlot.has(`${code}/${place}`)) place++;
    if (place < placesIn(code)) bySlot.set(`${code}/${place}`, item);
    else elsewhere.push(item);
  }
  return { bySlot, elsewhere };
}
