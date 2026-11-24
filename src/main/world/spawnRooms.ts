/**
 * Where the realm puts each monster row, the reverse of what a room states:
 * its resident (`Rooms.NPC`), its lair (`Rooms.Lair`) and the rows its group
 * may put in it as a player walks in (`WorldRoom.wanderers`). Each index is
 * one scan of the rooms for every monster, built on the first ask.
 * `mudengine-world` › `parts/quests.md` › *A dropper is hunted where it
 * wanders in too*.
 */
import { parseLair, type MobSpawn, type WorldMob, type WorldRoom } from '../../shared/world';
import type { Catalogue } from './Catalogue';

/**
 * One room the realm spawns a monster in, before the grouping.
 *
 * The room itself rather than its address, because the group is keyed on the
 * room's *name* and re-reading it out of the index per entry would be a lookup
 * per room in a scan built to avoid exactly that.
 */
export interface MobSpawnRoom {
  room: WorldRoom;
  via: MobSpawn['via'];
  /** The lair's slot count; null for a resident, which has no such figure. */
  max: number | null;
}

export class SpawnRooms {
  private placed: Map<number, MobSpawnRoom[]> | null = null;
  private wandered: Map<number, WorldRoom[]> | null = null;

  constructor(
    private readonly rooms: () => Iterable<WorldRoom>,
    private readonly catalogue: Pick<Catalogue, 'mob' | 'mobById'>
  ) {}

  /**
   * Every placement of this monster, one entry per room and slot, uncapped.
   * A name can hold several of the realm's rows (five `cocoon`s), each placed
   * separately, so every id behind the name contributes, asked of the id
   * index. Through the fold, not the argument: `mobAt` hands back a copy
   * re-answered by one row, and an identity test against it matches nothing
   * (the card lost its `spawns in` list the day rooms began resolving names).
   * Where one row was resolved, only that row's rooms are this monster's.
   */
  of(mob: WorldMob): MobSpawnRoom[] {
    return this.under(mob, this.placedByRow());
  }

  /** The placements of one row, for a search that already holds the rows. */
  ofRow(id: number): readonly MobSpawnRoom[] {
    return this.placedByRow().get(id) ?? [];
  }

  /**
   * Every room with no lair that this monster's group may put it in as a
   * player walks in, by the rows `of` reads. `Room.Regen` draws one of the
   * group's rows at `WANDERER_CHANCE` a player a pass, so it turns up there
   * less often than in a lair that lists it.
   */
  wanderedInto(mob: WorldMob): WorldRoom[] {
    return this.under(mob, this.wanderedByRow());
  }

  /** What an index holds under the rows that are this monster. */
  private under<T>(mob: WorldMob, index: ReadonlyMap<number, T[]>): T[] {
    const found: T[] = [];
    const fold = this.catalogue.mob(mob.name);
    const only = mob.row?.id;
    for (const [id, held] of index) {
      if (only !== undefined ? id !== only : this.catalogue.mobById(id) !== fold) continue;
      found.push(...held);
    }
    return found;
  }

  private placedByRow(): Map<number, MobSpawnRoom[]> {
    if (this.placed !== null) return this.placed;
    const index = new Map<number, MobSpawnRoom[]>();
    for (const room of this.rooms()) {
      if (room.npcId !== undefined) put(index, room.npcId, { room, via: 'npc', max: null });
      if (room.lair === undefined) continue;
      const { max, ids } = parseLair(room.lair);
      for (const id of ids) put(index, id, { room, via: 'lair', max });
    }
    this.placed = index;
    return index;
  }

  private wanderedByRow(): Map<number, WorldRoom[]> {
    if (this.wandered !== null) return this.wandered;
    const index = new Map<number, WorldRoom[]>();
    for (const room of this.rooms()) {
      for (const id of room.wanderers ?? []) put(index, id, room);
    }
    this.wandered = index;
    return index;
  }
}

function put<T>(index: Map<number, T[]>, id: number, entry: T): void {
  const bucket = index.get(id);
  if (bucket === undefined) index.set(id, [entry]);
  else bucket.push(entry);
}
