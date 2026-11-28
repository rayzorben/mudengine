/**
 * An item looked up, weighed against what is worn in its slot: the Reference
 * panel's side-by-side (`shared/wornBeside.ts`). The floor loot's question
 * (`floorGear`) asked of a row the player is reading, drawn rather than acted
 * on: the same equip check, the same ranking, the same piece it replaces.
 */
import type { CharacterState } from '../../shared/character';
import { entityNumber, wornCopy, type ItemEntity } from '../../shared/entities';
import { placesIn } from '../../shared/items';
import type { SlotGear } from '../../shared/slotGear';
import type { BesideVerdict, WornBeside, WornPiece } from '../../shared/wornBeside';
import type { WorldItem } from '../../shared/world';
import { handsInTheWay, rowOf, type FloorRealm } from './floorGear';
import { figuresOf, versusWorn, WEAR_SLOTS, weakestWorn, wornBySlot } from './gearUpgrades';
import { slotGear, type SlotAsker } from './slotGear';

/** A worn piece with its figures: its own row where the realm names one, else the pack's. */
function pieceOf(item: ItemEntity, gear: SlotGear, asker: SlotAsker, realm: FloorRealm): WornPiece {
  const id = entityNumber(item);
  const row = id === null ? undefined : gear.rows.find((each) => each.id === id);
  return {
    name: item.name,
    id,
    item: rowOf(item, realm) ?? null,
    figures: row ?? figuresOf(gear.rows, item, asker.weighing)
  };
}

function verdictOf(order: number): BesideVerdict {
  return order < 0 ? 'better' : order > 0 ? 'worse' : 'same';
}

/**
 * `row` beside what `state` wears in its slot. Null where it is not worn
 * gear, the equip check refuses it, or the character wears this very one.
 */
export function wornBeside(
  row: WorldItem,
  state: CharacterState,
  realm: FloorRealm,
  asker: SlotAsker
): WornBeside | null {
  const code = row.worn;
  if (code === undefined || !WEAR_SLOTS.includes(code)) return null;
  // Until a listing has said, what is worn is unknown, never nothing.
  const listed = state.inventory.listedAt !== null;
  const wornHere = listed ? (wornBySlot(state).get(code) ?? []) : [];
  if (wornCopy(wornHere, { name: row.name, id: row.id }) !== undefined) return null;
  const wornRows = wornHere.flatMap((item) => rowOf(item, realm) ?? []);
  const gear = slotGear(code, { itemsWornIn: () => [row, ...wornRows] }, asker);
  const item = gear.rows.find((each) => each.id === row.id);
  if (item === undefined) return null;
  // A place free in the slot (a second ring finger) replaces nothing.
  const full = listed && wornHere.length >= placesIn(code);
  const weakest = full ? weakestWorn(gear.rows, wornHere, gear.ranking, asker.weighing) : null;
  return {
    slot: gear.slot,
    ranking: gear.ranking,
    item,
    worn: listed ? wornHere.map((piece) => pieceOf(piece, gear, asker, realm)) : null,
    replaces: weakest?.item.name ?? null,
    verdict: weakest === null ? null : verdictOf(versusWorn(gear.ranking, item, weakest.figures)),
    handsFree: listed ? handsInTheWay(code, row, state, realm) : null,
    unread: gear.unread
  };
}
