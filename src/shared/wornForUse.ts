/**
 * The commands that put a carried item on for its `use` and put back what it
 * took the place of: a bless weapon into the hand (`offRoundSteps`, todo 42)
 * or bless armour into its own slot. `UseCommand` refuses either while it is
 * not worn (`You do not have <item> equipped.`). One plan for `AutoInvoke`,
 * which sends it, and Auto Choose Blessings, which prices it. See
 * `mudengine-automation` › parts/recovery.md, *A weapon that blesses is
 * chosen, and pays the spell's mana*.
 */
import type { CarriedItem } from './character';
import {
  equip,
  heldWeapon,
  offRoundSteps,
  unequip,
  type HandsOf,
  type OffRoundSteps
} from './gear';
import { OFF_HAND, placesOf, sameItem } from './items';

/** What the plan needs to know of an item: its hands and the slot it is worn in. */
export interface WornReads {
  handsOf: HandsOf;
  /** The slot an item goes in, as `Errands.gearSlotOf` reads it; null unknown. */
  slotOf(name: string): string | null;
}

/** The plan for a carried item that must be worn to be used, or null where there is none. */
export function useFromPackSteps(
  item: string,
  weapon: boolean,
  items: readonly CarriedItem[],
  reads: WornReads
): OffRoundSteps | null {
  return weapon
    ? offRoundSteps(item, null, items, reads.handsOf)
    : wornForUseSteps(item, items, reads);
}

/**
 * Armour in the pack: worn, used, and what was in its slot worn again.
 *
 * `wear` takes a free place of the slot, else takes off what is in the first
 * place and goes there (`EquipCommand.Execute`). So a slot of one place is
 * `wear`, `use`, `wear` the old item. A slot of two places with both worn
 * (rings, wrists) does not say which is the first, so one comes off by name,
 * the item goes in its place and comes off again before the old one goes
 * back. With a place free nothing is taken off, and the item stays on.
 *
 * Null where the slot is unknown, where any worn item's slot is unknown (it
 * could be the one `wear` takes off), or where the item is for the off-hand
 * under a two-handed weapon, which the server refuses.
 */
function wornForUseSteps(
  item: string,
  items: readonly CarriedItem[],
  reads: WornReads
): OffRoundSteps | null {
  const carried = items.find((each) => sameItem(each.name, item));
  if (carried === undefined) return null;
  const use = `use ${carried.name}`;
  if (carried.equipped) return { commands: [use], useAt: 0, putBack: null, kept: [] };

  const slot = reads.slotOf(carried.name)?.toLowerCase() ?? null;
  if (slot === null) return null;
  const worn = items.filter((each) => each.equipped);
  const slots = worn.map((each) => reads.slotOf(each.name)?.toLowerCase() ?? null);
  if (slots.includes(null)) return null;
  if (slot === OFF_HAND.toLowerCase()) {
    const held = heldWeapon(items);
    if (held !== undefined && reads.handsOf(held.name) === 2) return null;
  }

  const inSlot = worn.filter((_, index) => slots[index] === slot);
  const on = equip(carried.name);
  if (inSlot.length < placesOf(slot))
    return { commands: [on, use], useAt: 1, putBack: null, kept: [] };
  const old = inSlot[0];
  if (old === undefined) return null;
  // Every item in the slot is kept: a `remove` refused (a cursed ring) leaves
  // the slot full, and the `wear` then takes off whichever is in the first place.
  const kept = inSlot.map((each) => each.name);
  return inSlot.length === 1
    ? { commands: [on, use, equip(old.name)], useAt: 1, putBack: old.name, kept }
    : {
        commands: [unequip(old.name), on, use, unequip(carried.name), equip(old.name)],
        useAt: 2,
        putBack: old.name,
        kept
      };
}
