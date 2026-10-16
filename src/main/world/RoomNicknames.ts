/**
 * MegaMUD's room names on one realm: the shipped entries
 * (`src/shared/roomNicknames.ts`) whose room this realm has at the same
 * address under the same name. Every other entry is left out, so the table
 * built against Paradigm keeps what still fits an older Paradigm and nothing
 * of stock MajorMUD. A name only ever produces a room id; the walk there is
 * the navigation engine's. See `mudengine-world` › `parts/realm.md`.
 */
import { codeKey, type RoomNickname } from '../../shared/roomNicknames';
import { roomId, type RoomId, type WorldRoom } from '../../shared/world';

/** The rooms an entry is checked against. */
export interface NicknameRooms {
  get(map: number, room: number): WorldRoom | undefined;
}

/** A MegaMUD name and the realm room it names. */
export interface NamedRoom {
  nickname: RoomNickname;
  room: WorldRoom;
}

export class RoomNicknames {
  private readonly codes = new Map<string, NamedRoom>();
  private readonly rooms = new Map<RoomId, RoomNickname[]>();
  /** The names a search finds: every one MegaMUD does not hide, lower-cased once. */
  private readonly listed: Array<{ folded: string; named: NamedRoom }> = [];

  constructor(entries: readonly RoomNickname[], realm: NicknameRooms) {
    for (const nickname of entries) {
      const { at, name } = nickname.room;
      const room = realm.get(at.map, at.room);
      if (room === undefined || room.name.trim() !== name) continue;
      const named = { nickname, room };
      this.codes.set(codeKey(nickname.code), named);
      const id = roomId(at.map, at.room);
      this.rooms.set(id, [...(this.rooms.get(id) ?? []), nickname]);
      if (!nickname.hidden) this.listed.push({ folded: nickname.name.toLowerCase(), named });
    }
  }

  /** How many entries fit this realm. */
  get size(): number {
    return this.codes.size;
  }

  /** The room a code names, case ignored, hidden names included; null where none fits. */
  byCode(code: string): NamedRoom | null {
    return this.codes.get(codeKey(code)) ?? null;
  }

  /** The rooms whose MegaMUD name holds `query`, in the file's order, up to `limit`. */
  search(query: string, limit: number): NamedRoom[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return [];
    const found: NamedRoom[] = [];
    for (const { folded, named } of this.listed) {
      if (!folded.includes(needle)) continue;
      found.push(named);
      if (found.length >= limit) break;
    }
    return found;
  }

  /**
   * MegaMUD's name for a room, as a search row and a route's arrival carry it:
   * one it stops before entering under, if any does, so no name of a boss
   * room walks into it; else the first it lists in the goto list; or null.
   */
  nameOf(id: RoomId): RoomNickname | null {
    const names = this.rooms.get(id) ?? [];
    return (
      names.find((nickname) => nickname.stopBefore) ??
      names.find((nickname) => !nickname.hidden) ??
      names[0] ??
      null
    );
  }
}

/**
 * One `RoomNicknames` per world, built on first ask and kept while the world
 * is, so a swapped realm builds its own. `fitted` hears how many of the
 * shipped entries each world kept, once per world.
 */
export class NicknameShelf {
  private readonly built = new WeakMap<NicknameRooms, RoomNicknames>();

  constructor(
    private readonly entries: () => readonly RoomNickname[],
    private readonly fitted: (kept: number, shipped: number) => void
  ) {}

  of(realm: NicknameRooms): RoomNicknames {
    const kept = this.built.get(realm);
    if (kept !== undefined) return kept;
    const entries = this.entries();
    const made = new RoomNicknames(entries, realm);
    if (entries.length > 0) this.fitted(made.size, entries.length);
    this.built.set(realm, made);
    return made;
  }
}
