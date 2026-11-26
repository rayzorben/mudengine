/**
 * Names for rooms the stock v1.11p database ships with a blank `Name`, shipped
 * as `resources/world/blank-room-names.csv`. The server prints a name for them
 * (`Entrance Silver House Room`, `Shop White House Room`), so a room block
 * could never match them and goto never listed them (`mudengine-world` ›
 * parts/realm.md, *A blank room name*). A row applies only where the
 * database's own name is blank: Paradigm and GreaterMUD name the same rooms.
 */
import { roomId } from '../../shared/world';
import { t } from '../app/i18n';
import { loadRoomTable, parseRoomTable, type RoomTable } from './roomTable';

/** The name the server prints, by `map/room`. */
export type BlankRoomNames = RoomTable;

export const NO_BLANK_ROOM_NAMES: BlankRoomNames = new Map();

export const BLANK_ROOM_NAMES_FILE = 'blank-room-names.csv';

export const parseBlankRoomNames = parseRoomTable;

/** `name` for a room the database leaves blank, else the database's own. */
export function nameOfRoom(
  names: BlankRoomNames,
  map: number,
  room: number,
  stated: string
): string {
  return stated.trim().length > 0 ? stated : (names.get(roomId(map, room)) ?? stated);
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
    notify
  );
}
