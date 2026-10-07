/**
 * The character as it would be wearing other items: what a planner surveys to
 * price an upgrade before buying it. Each item goes on in its realm slot over
 * the weakest worn there (`weakestWorn`, the item an upgrade replaces), or in
 * a free place; the sheet's armour class and damage resist move by the
 * difference at the sheet's scale (`REALM_ARMOUR_SCALE`), with both items'
 * figures read from the slot's realm rows as the rankings read them, and what
 * comes off stays in the pack. An item the pack already carries is put on, not
 * added; one already worn in its slot is left off (`wornCopy`). A worn
 * item the realm does not hold makes the sheet's figure unknown.
 */
import { placesIn } from '../../shared/items';
import { REALM_ARMOUR_SCALE } from '../../shared/menace';
import type { CharacterState } from '../../shared/character';
import { wornCopy, type ItemEntity } from '../../shared/entities';
import type { Wearing } from '../../shared/upgrades';
import { nameAnswersTo } from '../../shared/world';
import { figuresOf, weakestWorn, wornBySlot, type UpgradeRealm } from './gearUpgrades';
import { slotGear, type SlotAsker } from './slotGear';

export interface WearingRealm extends Pick<UpgradeRealm, 'itemsWornIn'> {
  buildItemEntity(name: string): ItemEntity;
}

/** A sheet figure moved by a realm-scale difference; unknown on either side is unknown. */
function moved(figure: number | null, on: number | null, off: number | null): number | null {
  return figure === null || on === null || off === null
    ? null
    : figure + (on - off) / REALM_ARMOUR_SCALE;
}

export function wearing(
  state: CharacterState,
  names: readonly string[],
  realm: WearingRealm,
  asker: SlotAsker
): Wearing {
  let out = state;
  const worn: string[] = [];
  for (const name of names) {
    const on = realm.buildItemEntity(name);
    const code = on.wornSlotCode;
    if (on.id === undefined || code === undefined) continue;
    const wornHere = wornBySlot(out).get(code) ?? [];
    if (wornCopy(wornHere, on) !== undefined) continue;
    const free = wornHere.length < placesIn(code);
    const gear = slotGear(code, realm, asker);
    const off = free ? null : (weakestWorn(gear.rows, wornHere, gear.ranking) ?? null);
    const onFigures = figuresOf(gear.rows, on);
    // A realm row with no armour block has none; only an item the realm does not hold is unknown.
    const offAc =
      off === null ? 0 : off.item.id === undefined ? off.figures.ac : (off.figures.ac ?? 0);
    const offDr =
      off === null ? 0 : off.item.id === undefined ? off.figures.dr : (off.figures.dr ?? 0);
    const carried = out.inventory.items.find(
      (item) => !item.equipped && nameAnswersTo(item.name, on.name)
    );
    const items = out.inventory.items.flatMap((item) => {
      if (item === off?.item) return [{ ...item, equipped: false, slot: null }];
      if (item === carried) return [{ ...item, equipped: true, slot: on.realmSlot ?? null }];
      return [item];
    });
    if (carried === undefined) items.push({ ...on, equipped: true, slot: on.realmSlot ?? null });
    // What the pack already carried weighs nothing more; the realm states no weight of 0.
    const weight = carried === undefined ? (on.encumbrance ?? 0) : 0;
    const { encumbrance } = out.inventory;
    out = {
      ...out,
      progress: {
        ...out.progress,
        armourClass: moved(out.progress.armourClass, onFigures.ac ?? 0, offAc),
        damageResist: moved(out.progress.damageResist, onFigures.dr ?? 0, offDr)
      },
      inventory: {
        ...out.inventory,
        items,
        encumbrance: encumbrance === null ? null : encumbrance + weight
      }
    };
    worn.push(on.name);
  }
  return { state: out, worn };
}
