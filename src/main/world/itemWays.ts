/**
 * The ways using an item opens where its run lands by chance or by a draw, as
 * commands of the rooms it works in (format 78): the obsidian talisman used
 * at an obsidian obelisk is `roomitem 802` then `random 1092`, whose 65% line
 * casts a draw over the labyrinth's dead ends and whose 10% line takes the
 * talisman. A use landing in one stated room every try is `WorldItem.lands`
 * (`landingsOfItems`); this is the rest, read through `scriptLandings` as
 * `dig grave` is. `mudengine-world` › `parts/routing.md` (an item used in a room
 * is a command of that room).
 */
import { commandMoves, type RoomCommand, type RoomId } from '../../shared/world';
import { nameGate, type GateNames } from './navigation/stepGates';
import { landingsOf, runEnds, type LandingRealm, type RunEnd } from './navigation/scriptLandings';
import type { TbStep } from './navigation/textblock';
import { roomsHoldingAll } from './indexQuests';
import type { RealmSource } from './RealmSource';
import { castsOf, number, text } from './values';

/** An item whose use casts spells (`CastsSp`), each tried in slot order. */
export interface UsedItem {
  id: number;
  name: string;
  spells: readonly number[];
}

/** Every room's item ways, by the items lying in it. */
export class ItemWays {
  private readonly byRoom = new Map<RoomId, UsedItem[]>();

  /**
   * `holding` is where each item lies (`roomsHoldingItems`); `landed` is an
   * item whose use already has a stated landing, which stays `lands`.
   */
  constructor(
    items: readonly UsedItem[],
    private readonly holding: ReadonlyMap<number, readonly string[]>,
    private readonly realm: Omit<LandingRealm, 'here'>,
    private readonly names: GateNames,
    landed: (item: number) => boolean
  ) {
    for (const item of items) {
      if (landed(item.id)) continue;
      for (const room of this.roomsFor(item)) {
        (this.byRoom.get(room) ?? this.byRoom.set(room, []).get(room)!).push(item);
      }
    }
  }

  /** The item ways of one room. */
  in(here: RoomId): RoomCommand[] {
    return (this.byRoom.get(here) ?? []).flatMap((item) => this.read(item, here));
  }

  /**
   * The rooms holding every item a moving end wants lying on the floor. A
   * use whose run wants nothing lying there works wherever the character
   * stands, which no room's command is.
   */
  private roomsFor(item: UsedItem): RoomId[] {
    const wanted = new Set(
      this.ends(item, null)
        .filter((end) => end.rooms.length > 0)
        .flatMap((end) => end.inner.flatMap((step) => lyingItem(step) ?? []))
    );
    return roomsHoldingAll(wanted, this.holding) as RoomId[];
  }

  private read(item: UsedItem, here: RoomId): RoomCommand[] {
    // What lies in this room is no gate in it.
    const ends = this.ends(item, here).map((end) => ({
      ...end,
      inner: end.inner.filter((step) => {
        const lying = lyingItem(step);
        return lying === null || !(this.holding.get(lying) ?? []).includes(here);
      })
    }));
    const moves = landingsOf(ends, this.names);
    if (!commandMoves(moves)) return [];
    const carry = nameGate({ kind: 'carry', item: item.id }, this.names);
    return [{ say: [`use ${item.name}`], ...moves, gates: [carry] }];
  }

  /** The ends of the first spell whose run moves anybody, as `landingsOfItems` takes the first. */
  private ends(item: UsedItem, here: RoomId | null): RunEnd[] {
    for (const spell of item.spells) {
      const cast: TbStep = { verb: 'cast', spell, text: `cast ${spell}`, said: `cast ${spell}` };
      const ends = runEnds([cast], { ...this.realm, here });
      if (ends.some((end) => end.rooms.length > 0)) return ends;
    }
    return [];
  }
}

/** The item a `roomitem` step wants lying in the room, or null. */
function lyingItem(step: TbStep): number | null {
  return step.verb === 'roomitem' && step.item > 0 ? step.item : null;
}

/** Every item whose use casts a spell (`CastsSp`). */
export function usedItems(source: RealmSource): UsedItem[] {
  const found: UsedItem[] = [];
  for (const row of source.table('Items')?.rows ?? []) {
    const id = number(row['Number']);
    const name = text(row['Name']).trim();
    const spells = castsOf(row);
    if (id !== null && id > 0 && name.length > 0 && spells.length > 0) {
      found.push({ id, name, spells });
    }
  }
  return found;
}
