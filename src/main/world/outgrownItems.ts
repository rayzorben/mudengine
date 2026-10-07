/**
 * The gear the pack carries and the character has outgrown: an unworn item
 * for a slot that is full and holds something at least as good, by the ranking
 * the upgrades are bought by (`gearUpgrades`). An item for a slot with room in
 * it (a second ring finger, an empty off-hand) could still be worn, and is not
 * listed; a spare of an item already worn never could (`wornCopy`), and
 * `OutgrownGear` keeps one whatever is listed, since `sell` takes the worn
 * copy too. Each with its worth in copper where the realm's rows agree on one.
 */
import { placesIn } from '../../shared/items';
import type { CharacterState } from '../../shared/character';
import { counterPriceInCopper } from '../../shared/coins';
import type { ItemEntity } from '../../shared/entities';
import type { OutgrownItem } from '../../shared/outgrown';
import type { WorldItem } from '../../shared/world';
import { figuresOf, versusWorn, WEAR_SLOTS, weakestWorn, wornBySlot } from './gearUpgrades';
import { slotGear, type SlotAsker } from './slotGear';

export interface OutgrownRealm {
  itemsWornIn(worn: number): readonly WorldItem[];
  item(id: number): WorldItem | undefined;
}

/** One price for the name, in copper, or null: a shared name whose rows differ has no one worth. */
function copperOf(item: ItemEntity, realm: OutgrownRealm): number | null {
  const ids =
    item.row !== undefined ? [item.row.id] : (item.ids ?? (item.id === undefined ? [] : [item.id]));
  const prices = ids.map((id) => {
    const row = realm.item(id);
    return row?.price === undefined || row.currency === undefined
      ? null
      : counterPriceInCopper(row.price, row.currency, 0);
  });
  const first = prices[0];
  return first === undefined || first === null || prices.some((price) => price !== first)
    ? null
    : first;
}

export function outgrownItems(
  state: CharacterState,
  realm: OutgrownRealm,
  asker: SlotAsker
): OutgrownItem[] {
  const worn = wornBySlot(state);
  const slots = new Map<number, ReturnType<typeof slotGear>>();
  const found: OutgrownItem[] = [];
  for (const item of state.inventory.items) {
    const code = item.wornSlotCode;
    if (item.equipped || code === undefined || !WEAR_SLOTS.includes(code)) continue;
    const wornHere = worn.get(code) ?? [];
    if (wornHere.length < placesIn(code)) continue;
    const gear = slots.get(code) ?? slotGear(code, realm, asker);
    slots.set(code, gear);
    const weakest = weakestWorn(gear.rows, wornHere, gear.ranking);
    if (weakest === null) continue;
    if (versusWorn(gear.ranking, figuresOf(gear.rows, item), weakest.figures) < 0) continue;
    found.push({
      item,
      slot: gear.slot,
      worn: weakest.item.name,
      copper: copperOf(item, realm)
    });
  }
  return found;
}
