/**
 * What this character hid, where and when (todo 05, 2026-10-03).
 *
 * `hide <item>` (`StashCommand`) puts the item in the room's hidden pile, which
 * no `You notice` lists and which the server keeps only on the room. Without a
 * record the client forgot it the moment the pack stopped holding it. Added on
 * `You hid …` in the room the character stood in, taken down by `You took …`
 * in that room, kept per character and realm in the character's record
 * (`Belongings`). A hide in a room the client could not place is kept with the
 * room unknown, never guessed. Pure and dependency-free like all of `shared/`.
 */
import { sameItem } from './items';

/** One item hidden in one room, with how many and when last hidden. */
export interface StashEntry {
  /** The room's realm numbers; null where the character was not placed. */
  map: number | null;
  room: number | null;
  /** The room's printed name, for the card; null where none was read. */
  name: string | null;
  item: string;
  count: number;
  at: number;
}

export type Stash = readonly StashEntry[];

/** The room a hide or a take happened in, as the state placed it. */
export interface StashPlace {
  map: number | null;
  room: number | null;
  name: string | null;
}

/** The room as the state placed it, as a stash records it. */
export function placeOf(room: {
  map: number | null;
  number: number | null;
  name: string | null;
}): StashPlace {
  return { map: room.map, room: room.number, name: room.name };
}

const samePlace = (entry: StashEntry, place: StashPlace): boolean =>
  entry.map === place.map && entry.room === place.room;

/** `You hid` in `place`: the count added to that room's entry for the item, or a new one. */
export function withHidden(
  stash: Stash,
  place: StashPlace,
  item: string,
  count: number,
  at: number
): Stash {
  const held = stash.find((entry) => samePlace(entry, place) && sameItem(entry.item, item));
  if (held === undefined) return [...stash, { ...place, item, count, at }];
  return stash.map((entry) =>
    entry === held
      ? { ...entry, count: entry.count + count, at, name: place.name ?? entry.name }
      : entry
  );
}

/**
 * `You took` in a placed room: the count off that room's entry for the item,
 * the entry gone at none. The same identity back where the room holds none of
 * it, so a pick-up anywhere else writes nothing. An unplaced room takes from
 * nothing: which pile it was is not known.
 */
export function withTaken(stash: Stash, place: StashPlace, item: string, count: number): Stash {
  if (place.map === null || place.room === null) return stash;
  const held = stash.find((entry) => samePlace(entry, place) && sameItem(entry.item, item));
  if (held === undefined) return stash;
  const left = held.count - count;
  return left > 0
    ? stash.map((entry) => (entry === held ? { ...entry, count: left } : entry))
    : stash.filter((entry) => entry !== held);
}

/** Parsed, not trusted: the record is a file on disk anything may have edited. */
export function isStashEntry(value: unknown): value is StashEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<StashEntry>;
  const whole = (figure: unknown): boolean => figure === null || Number.isInteger(figure);
  return (
    whole(entry.map) &&
    whole(entry.room) &&
    (entry.map === null) === (entry.room === null) &&
    (entry.name === null || typeof entry.name === 'string') &&
    typeof entry.item === 'string' &&
    entry.item.length > 0 &&
    Number.isInteger(entry.count) &&
    (entry.count ?? 0) > 0 &&
    typeof entry.at === 'number' &&
    Number.isFinite(entry.at)
  );
}

/** One room's part of the stash, as the Inventory card draws it: newest hide first. */
export interface StashRoom {
  map: number | null;
  room: number | null;
  name: string | null;
  /** `3 torch`, `padded gloves`: the count before the name, as the server lists a pile. */
  items: string[];
  at: number;
}

/** The stash by room, the room hidden in last first. */
export function stashRooms(stash: Stash): StashRoom[] {
  const rooms: StashRoom[] = [];
  for (const entry of stash) {
    const named = entry.count > 1 ? `${entry.count} ${entry.item}` : entry.item;
    const held = rooms.find((room) => room.map === entry.map && room.room === entry.room);
    if (held === undefined) {
      const { map, room, name, at } = entry;
      rooms.push({ map, room, name, items: [named], at });
    } else {
      held.items.push(named);
      held.at = Math.max(held.at, entry.at);
      held.name = held.name ?? entry.name;
    }
  }
  return rooms.sort((a, b) => b.at - a.at);
}
