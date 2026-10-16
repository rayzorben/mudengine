/**
 * Room names on one realm: the player's own `rooms:` list in front of
 * MegaMUD's shipped one (`src/shared/roomNicknames.ts`), each entry kept only
 * where this realm has its room at the same address under the same name.
 * Every other entry is left out, so the table built against Paradigm keeps
 * what still fits an older Paradigm and nothing of stock MajorMUD. A name only
 * ever produces a room id; the walk there is the navigation engine's. See
 * `mudengine-world` › `parts/realm.md`.
 */
import { codeKey, type RoomNickname } from '../../shared/roomNicknames';
import { sameJson } from '../../shared/values';
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
  /** The names a search finds: every one not hidden, lower-cased once. */
  private readonly listed: Array<{ folded: string; named: NamedRoom }> = [];
  /** How many of the shipped entries this realm kept. */
  readonly shippedKept: number;
  /** The player's codes whose room this realm does not have under that name. */
  readonly unfit: string[] = [];
  /** The player's codes that take the place of a shipped entry's on this realm. */
  readonly overrides: string[] = [];

  /** `own` is the player's list, in front: a code it names here is never the shipped entry's. */
  constructor(
    shipped: readonly RoomNickname[],
    realm: NicknameRooms,
    own: readonly RoomNickname[] = []
  ) {
    for (const nickname of own) {
      if (!this.keep(nickname, realm)) this.unfit.push(nickname.code);
    }
    const mine = new Set(this.codes.keys());
    let kept = 0;
    for (const nickname of shipped) {
      const taken = mine.has(codeKey(nickname.code));
      if (!taken && this.keep(nickname, realm)) kept += 1;
      else if (taken && this.fits(nickname, realm) !== undefined) {
        this.overrides.push(nickname.code);
      }
    }
    this.shippedKept = kept;
  }

  /** The realm room an entry names, where the realm has it under that name. */
  private fits(nickname: RoomNickname, realm: NicknameRooms): WorldRoom | undefined {
    const { at, name } = nickname.room;
    const room = realm.get(at.map, at.room);
    return room === undefined || room.name.trim() !== name ? undefined : room;
  }

  /** Lists an entry that fits and whose code nothing before it took; whether it did. */
  private keep(nickname: RoomNickname, realm: NicknameRooms): boolean {
    const room = this.fits(nickname, realm);
    if (room === undefined || this.codes.has(codeKey(nickname.code))) return false;
    const named = { nickname, room };
    this.codes.set(codeKey(nickname.code), named);
    const id = roomId(nickname.room.at.map, nickname.room.at.room);
    this.rooms.set(id, [...(this.rooms.get(id) ?? []), nickname]);
    if (!nickname.hidden) this.listed.push({ folded: nickname.name.toLowerCase(), named });
    return true;
  }

  /** How many entries fit this realm. */
  get size(): number {
    return this.codes.size;
  }

  /** The room a code names, case ignored, hidden names included; null where none fits. */
  byCode(code: string): NamedRoom | null {
    return this.codes.get(codeKey(code)) ?? null;
  }

  /** The rooms whose listed name holds `query`, in the file's order, up to `limit`. */
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

/** The two lists a realm's names are built from, read on each ask. */
export interface NicknameLists {
  /** MegaMUD's, as shipped; read once by its owner. */
  shipped(): readonly RoomNickname[];
  /** The player's own, from the options file, in front of the shipped list. */
  own(): readonly RoomNickname[];
}

/** What building a realm's names is said through. */
export interface NicknameNotices {
  /** How many of the shipped entries a world kept, once per world. */
  fitted(kept: number, shipped: number): void;
  /** The player's codes a world has no room for under that name. */
  unfit(codes: readonly string[]): void;
  /** The player's codes that take a shipped entry's place on a world. */
  overrides(codes: readonly string[]): void;
}

/**
 * One `RoomNicknames` per world, built on first ask and again when the
 * player's list changes, kept while the world is, so a swapped realm builds
 * its own. What a build left out is said once per world and per change of the
 * player's list, so a reload of an unchanged file says nothing again.
 */
export class NicknameShelf {
  private readonly built = new WeakMap<
    NicknameRooms,
    { own: readonly RoomNickname[]; names: RoomNicknames }
  >();

  constructor(
    private readonly lists: NicknameLists,
    private readonly heard: NicknameNotices
  ) {}

  of(realm: NicknameRooms): RoomNicknames {
    const own = this.lists.own();
    const kept = this.built.get(realm);
    if (kept !== undefined && (kept.own === own || sameJson(kept.own, own))) {
      if (kept.own !== own) this.built.set(realm, { own, names: kept.names });
      return kept.names;
    }
    const shipped = this.lists.shipped();
    const names = new RoomNicknames(shipped, realm, own);
    if (kept === undefined && shipped.length > 0)
      this.heard.fitted(names.shippedKept, shipped.length);
    if (names.unfit.length > 0) this.heard.unfit(names.unfit);
    if (names.overrides.length > 0) this.heard.overrides(names.overrides);
    this.built.set(realm, { own, names });
    return names;
  }
}
