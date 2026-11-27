/**
 * Names for rooms the stock v1.11p database ships with a blank `Name`, shipped
 * as `resources/world/blank-room-names.csv`. The server prints a name for them
 * (`Entrance Silver House Room`, `Shop White House Room`), so a room block
 * could never match them and goto never listed them (`mudengine-world` ›
 * parts/realm.md, *A blank room name*). A row applies only where the
 * database's own name is blank: Paradigm and GreaterMUD name the same rooms.
 * Where the server prints a name other than Paradigm's, the `paradigm` column
 * has Paradigm's, which MegaMUD's room list is tied to.
 */
import { roomId } from '../../shared/world';
import { t } from '../app/i18n';
import { loadRoomTable, parseRoomTable, type RoomTable } from './roomTable';

export interface BlankRoomNames {
  /** The name the server prints, by `map/room`. */
  printed: RoomTable;
  /** Paradigm's name for the same room, only where it is not the printed one. */
  paradigm: RoomTable;
}

export const NO_BLANK_ROOM_NAMES: BlankRoomNames = { printed: new Map(), paradigm: new Map() };

export const BLANK_ROOM_NAMES_FILE = 'blank-room-names.csv';

export function parseBlankRoomNames(text: string): BlankRoomNames {
  return { printed: parseRoomTable(text), paradigm: parseRoomTable(text, 3) };
}

/** `name` for a room the database leaves blank, else the database's own. */
export function nameOfRoom(
  names: BlankRoomNames,
  map: number,
  room: number,
  stated: string
): string {
  return stated.trim().length > 0 ? stated : (names.printed.get(roomId(map, room)) ?? stated);
}

/** Paradigm's name for a room the database leaves blank, where the server prints another. */
export function paradigmNameOf(
  names: BlankRoomNames,
  map: number,
  room: number,
  stated: string
): string | undefined {
  return stated.trim().length > 0 ? undefined : names.paradigm.get(roomId(map, room));
}

/** The shipped table from `dir`, or none with the reason said. */
export function loadBlankRoomNames(
  dir: string,
  notify?: (message: string) => void
): BlankRoomNames {
  return loadRoomTable(
    dir,
    BLANK_ROOM_NAMES_FILE,
    (file, message) => t('notices.world.blankRoomNames.readError', { file, message }),
    NO_BLANK_ROOM_NAMES,
    parseBlankRoomNames,
    notify
  );
}
