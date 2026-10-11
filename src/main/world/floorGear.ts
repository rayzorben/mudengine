/**
 * An item on the floor weighed against what is worn in its slot (todo 77): the
 * ranking the upgrades are bought by (`slotGear`, `versusWorn`), asked of two
 * or three rows rather than the slot's whole list, so a floor listing costs a
 * few row reckonings and never the slot sweep. The loot takes what this calls
 * better; the outgrown trip then sells or stashes what came off.
 */
import type { CharacterState } from '../../shared/character';
import { entityNumber, wornCopy, type ItemEntity } from '../../shared/entities';
import { inOffHand } from '../../shared/gear';
import { lockedSlots } from '../../shared/gearLocks';
import { OFF_HAND_WORN, placesIn, sameItem, WEAPON_WORN, wornOfWord } from '../../shared/items';
import type { FloorGear, FloorRefusal } from '../../shared/upgrades';
import { nameAnswersTo, type WorldItem } from '../../shared/world';
import { carriedUnworn, versusWorn, WEAR_SLOTS, weakestWorn, wornBySlot } from './gearUpgrades';
import { slotGear, type SlotAsker } from './slotGear';

export interface FloorRealm {
  item(id: number): WorldItem | undefined;
}

/** The realm's row for a worn or floor item, where one row is named. */
function rowOf(item: ItemEntity, realm: FloorRealm): WorldItem | undefined {
  const id = entityNumber(item);
  return id === null ? undefined : realm.item(id);
}

/**
 * What `floor` is to this character's gear. `kit` is the items gear sets name
 * while gear sets are on (`automation.gear`): a set puts its item back,
 * so a better one would be worn and taken off again.
 */
export function floorGear(
  floor: ItemEntity,
  state: CharacterState,
  realm: FloorRealm,
  /** Read only for an item worn in a slot: it reckons the character's sheet. */
  askerOf: () => SlotAsker,
  kit: readonly string[]
): FloorGear | null {
  const code = floor.wornSlotCode;
  if (code === undefined || !WEAR_SLOTS.includes(code)) return null;
  // A name several rows share is not weighed: which row lies here is unknown.
  const row = rowOf(floor, realm);
  if (row === undefined) return null;
  const wornHere = wornBySlot(state).get(code) ?? [];
  // One already carried is worn or outgrown, never fetched again; a worn copy cannot go on twice.
  if (carriedUnworn(state).has(row.name.toLowerCase())) return null;
  if (wornCopy(wornHere, { name: row.name, id: row.id }) !== undefined) return null;
  const wornRows = wornHere.flatMap((item) => rowOf(item, realm) ?? []);
  const gear = slotGear(code, { itemsWornIn: () => [row, ...wornRows] }, askerOf());
  // Refused by the equip check (class, race, level, alignment, armour kind).
  const candidate = gear.rows.find((each) => each.id === row.id);
  if (candidate === undefined) return null;
  const free = placesIn(code) - wornHere.length;
  const weakest = free > 0 ? null : weakestWorn(gear.rows, wornHere, gear.ranking);
  if (free <= 0 && (weakest === null || versusWorn(gear.ranking, candidate, weakest.figures) >= 0))
    return null;
  const over = weakest?.item.name ?? null;
  const refused = (why: FloorRefusal, worn: string | null): FloorGear => ({
    kind: 'refused',
    slot: gear.slot,
    why,
    worn
  });
  if (over !== null && kit.some((name) => nameAnswersTo(over, name))) return refused('kit', over);
  // A slot held since a death keeps the gear died in (todo 82); only that item may fill it.
  const held = lockedSlots(state.loadout).find(
    (worn) => wornOfWord(worn.slot) === code && !sameItem(worn.item, row.name)
  );
  if (held !== undefined) return refused('locked', held.item);
  /*
   * `EquipCommand` refuses a two-hander with the off-hand worn and an off-hand
   * item with a two-hander readied. The first could go on once the off-hand
   * comes off, but that item's armour is not weighed against the blow here
   * (open question in todo 77), so both are left lying.
   */
  const hands = row.weapon?.hands ?? null;
  const offHand = inOffHand(state.inventory.items);
  if (code === WEAPON_WORN && hands === 2 && offHand !== undefined) {
    return refused('hands', offHand.name);
  }
  const weapon = (wornBySlot(state).get(WEAPON_WORN) ?? [])[0];
  if (code === OFF_HAND_WORN && weapon !== undefined && rowOf(weapon, realm)?.weapon?.hands === 2) {
    return refused('hands', weapon.name);
  }
  // `GetCommand` refuses an item heavier than the free weight; unread is not room.
  const { encumbrance, encumbranceMax } = state.inventory;
  if (encumbrance === null || encumbranceMax === null) return refused('unread', null);
  if ((row.encumbrance ?? 0) > encumbranceMax - encumbrance) return refused('heavy', null);
  return {
    kind: 'better',
    slot: gear.slot,
    over,
    replaces: placesIn(code) > 1 ? over : null,
    hands
  };
}
