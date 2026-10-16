/**
 * Names for rooms: MegaMUD's goto list (`ROOMS.md`), as the client ships it in
 * `resources/rooms/megamud.yaml` (`npm run build:rooms`), and the player's own
 * `rooms:` list in the options file, in the same shape (todo 153). Each names
 * one realm room by the realm's own name and address, so a realm whose room
 * there is called something else keeps none of it (`world/RoomNicknames.ts`).
 * See `mudengine-world` › `parts/realm.md`.
 */
import type { UiLookup } from './i18n';
import { splitStop } from './loops';
import { isRecord } from './values';
import type { RoomReference } from './world';

export interface RoomNickname {
  /** MegaMUD's code for it, `VXDF`: what its goto list and `@goto` take. */
  code: string;
  /** MegaMUD's name for it, `Darkwood Forest Vortex`. */
  name: string;
  /** The realm room it was built against: the realm's name for it, and where it is. */
  room: { name: string; at: RoomReference };
  /** MegaMUD's "Stop before entering room": its boss rooms. */
  stopBefore: boolean;
  /** MegaMUD's "Avoid this room". */
  avoid: boolean;
  /** MegaMUD's "Hide in goto list": a fork or a waypoint, found by its code only. */
  hidden: boolean;
  /** The level range MegaMUD records for it; null where it records none. */
  minLevel: number | null;
  maxLevel: number | null;
}

/** A code, case ignored: `vxdf` is `VXDF`. */
export const codeKey = (code: string): string => code.trim().toUpperCase();

const CODE = /^[^\s:]{1,8}$/;

/** Why an entry of a `rooms:` list is not loaded. */
export type RoomNameFault = 'code' | 'name' | 'room' | 'repeated';

/** An entry left out: its place in the list from 0, its code as written, and why. */
export interface RoomNameRefusal {
  at: number;
  code: string;
  fault: RoomNameFault;
}

/**
 * The entries of a parsed `rooms:` list that are whole, in order. An entry
 * missing its code, name or `Name map/room` is left out rather than guessed at,
 * and so is a code met again (case ignored): the first keeps it, since a code
 * names one room. `refused` hears each entry left out.
 */
export function asRoomNicknames(
  value: unknown,
  refused: (refusal: RoomNameRefusal) => void = () => undefined
): RoomNickname[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry: unknown, at): RoomNickname[] => {
    const row = isRecord(entry) ? entry : {};
    const { code, name, room } = row;
    const refuse = (fault: RoomNameFault): RoomNickname[] => {
      refused({ at, code: typeof code === 'string' ? code : '', fault });
      return [];
    };
    if (typeof code !== 'string' || !CODE.test(code)) return refuse('code');
    if (typeof name !== 'string' || name.trim().length === 0) return refuse('name');
    if (typeof room !== 'string') return refuse('room');
    const stop = splitStop({ room });
    if (stop.at === null || stop.name.length === 0) return refuse('room');
    if (seen.has(codeKey(code))) return refuse('repeated');
    seen.add(codeKey(code));
    return [
      {
        code,
        name: name.trim(),
        room: { name: stop.name, at: stop.at },
        stopBefore: row['stopBefore'] === true,
        avoid: row['avoid'] === true,
        hidden: row['hidden'] === true,
        minLevel: level(row['minLevel']),
        maxLevel: level(row['maxLevel'])
      }
    ];
  });
}

/** A level as an entry states it: a whole number above 0, else none. */
export const level = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

/** Why an entry is not loaded, in words. */
export function roomNameFaultText(fault: RoomNameFault, t: UiLookup): string {
  switch (fault) {
    case 'code':
      return t('settings.rooms.refusal.code');
    case 'name':
      return t('settings.rooms.refusal.name');
    case 'room':
      return t('settings.rooms.refusal.room');
    case 'repeated':
      return t('settings.rooms.refusal.repeated');
    default: {
      const never: never = fault;
      return never;
    }
  }
}

/** An entry left out, as a notice names it: its code, or its place where it has none. */
export const refusedEntryName = ({ at, code }: RoomNameRefusal): string =>
  code.trim().length > 0 ? code.trim() : `#${at + 1}`;

/**
 * One entry of the player's `rooms:` list as the file states it, before
 * anything is refused, so the settings page shows a refused entry with its
 * reason instead of losing it on the next save. Read and written by
 * `statedRoomNames` and `writtenRoomNames`; loaded by `asRoomNicknames`.
 */
export interface StatedRoomName {
  code: string;
  name: string;
  /** `Name map/room`, as a loop stop names a room. */
  room: string;
  stopBefore: boolean;
  avoid: boolean;
  hidden: boolean;
  minLevel: number | null;
  maxLevel: number | null;
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

/** Every entry as written, from a file or a form; anything that is not a map is none. */
export function statedRoomNames(value: unknown): StatedRoomName[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown): StatedRoomName[] =>
    isRecord(entry)
      ? [
          {
            code: text(entry['code']),
            name: text(entry['name']),
            room: text(entry['room']),
            stopBefore: entry['stopBefore'] === true,
            avoid: entry['avoid'] === true,
            hidden: entry['hidden'] === true,
            minLevel: level(entry['minLevel']),
            maxLevel: level(entry['maxLevel'])
          }
        ]
      : []
  );
}

const typed = (row: StatedRoomName): boolean =>
  [row.code, row.name, row.room].some((field) => field.trim().length > 0);

/** The rows as the file holds them; a row with nothing typed in it is not written. */
export function writtenRoomNames(rows: readonly StatedRoomName[]): Array<Record<string, unknown>> {
  return rows.filter(typed).map(roomNameEntry);
}

/** Why each row is not loaded, by its place among `rows`, as the client reads the file. */
export function roomNameFaults(rows: readonly StatedRoomName[]): Map<number, RoomNameFault> {
  const kept = rows.flatMap((row, at) => (typed(row) ? [at] : []));
  const faults = new Map<number, RoomNameFault>();
  asRoomNicknames(writtenRoomNames(rows), ({ at, fault }) => faults.set(kept[at]!, fault));
  return faults;
}

/** A row as the file holds it: the three names, then only the marks it has. */
function roomNameEntry(row: StatedRoomName): Record<string, unknown> {
  return {
    code: row.code.trim(),
    name: row.name.trim(),
    room: row.room.trim(),
    ...(row.stopBefore ? { stopBefore: true } : {}),
    ...(row.avoid ? { avoid: true } : {}),
    ...(row.hidden ? { hidden: true } : {}),
    ...(row.minLevel === null ? {} : { minLevel: row.minLevel }),
    ...(row.maxLevel === null ? {} : { maxLevel: row.maxLevel })
  };
}
