/**
 * What a room's own spell wants carried, for a walk and for whoever walks it
 * (todo 20261021-1200-01): the Silver River's `river damage` is stopped by a
 * log raft, a wooden skiff, a silverbark canoe or a river punt, and a
 * character without one takes fifteen hit points a tick. One reading for the
 * area search's walls, the walk's refusal, the rest refusal and the party's
 * question. `mudengine-world` › `parts/routing.md`.
 */
import {
  hazardAvoided,
  hazardCarried,
  hazardStoppers,
  type RoomId,
  type SpellHazard
} from '../../../shared/world';

/** A room spell on a way that an item stops, with the items that stop it. */
export interface WayStopper {
  spell: number;
  /** The realm's name for the spell: `river damage`. */
  name: string;
  /** The items that stop it, in the realm's order, each named. */
  items: Array<{ id: number; name: string }>;
}

/** What the realm says of one room's spell. */
export interface RoomSpell {
  id: number;
  name: string;
  hazard: SpellHazard;
}

export interface StopperRealm {
  /** The room's own spell and what it does to this character, or null where it casts nothing read. */
  roomSpell(room: RoomId): RoomSpell | null;
  itemName(item: number): string | undefined;
}

/**
 * Whether a room's spell hurts: the realm states a figure a tick for it. A
 * chain with no figure is priced, never refused or walled (Paradigm's desert,
 * 936 rooms the Dao Lord quest crosses), and so is one that only summons or
 * moves. The one test every reader here makes.
 */
export function hurts(hazard: Pick<SpellHazard, 'damage'>): boolean {
  return hazard.damage !== undefined && hazard.damage > 0;
}

/**
 * The room spells along these rooms that hurt and an item stops, folded per
 * spell in the order first met, whatever the pack holds: a leader carrying a
 * raft still has a party to ask. Empty `items` means nothing holdable stops
 * it, so such a spell is left out.
 */
export function stoppersAlong(rooms: Iterable<RoomId>, realm: StopperRealm): WayStopper[] {
  const found = new Map<number, WayStopper>();
  for (const room of rooms) {
    const spell = realm.roomSpell(room);
    if (spell === null || found.has(spell.id) || !hurts(spell.hazard)) continue;
    // What takes its damage off: the rest is priced, never refused (`hurts`).
    const items = hazardStoppers(spell.hazard, 'fails', 'damage').flatMap((id) => {
      const name = realm.itemName(id);
      return name === undefined ? [] : [{ id, name }];
    });
    if (items.length === 0) continue;
    found.set(spell.id, { spell: spell.id, name: spell.name, items });
  }
  return [...found.values()];
}

/**
 * Whether a room's spell hurts a character carrying `carrying` with the wards
 * `spellsUp` stated up (`hurts`, and nothing carried or up stops it). An
 * unlisted pack stops nothing.
 */
export function hurtsUnstopped(
  hazard: SpellHazard,
  carrying: readonly number[] | null,
  spellsUp: readonly number[]
): boolean {
  const pack = carrying ?? undefined;
  return hurts(hazardCarried(hazard, pack, spellsUp)) && !hazardAvoided(hazard, pack, spellsUp);
}

/** Whether the pack stops this stopper's spell; an unlisted pack does not. */
export function stopperHeld(
  stopper: Pick<WayStopper, 'items'>,
  carrying: readonly number[] | null
): boolean {
  return carrying !== null && stopper.items.some((item) => carrying.includes(item.id));
}
