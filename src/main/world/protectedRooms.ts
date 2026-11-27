/**
 * The official realm's protected rooms (`RM_PROTECTED`), shipped as
 * `resources/world/protected-rooms.csv` by `scripts/build-protected-rooms.mjs`
 * because no `.mdb` export carries `Rooms.Attributes`. `buildRealm` marks a
 * room protected where its map, number and name all match a row; a room the
 * table does not name is unknown, never "not protected"
 * (`mudengine-world` › parts/realm.md, todo 87).
 */
import { t } from '../app/i18n';
import { loadRoomTable, parseRoomTable, type RoomTable } from './roomTable';

/** Room name by `map/room`, for every protected room the table names. */
export type ProtectedRooms = RoomTable;

export const NO_PROTECTED_ROOMS: ProtectedRooms = new Map();

export const PROTECTED_ROOMS_FILE = 'protected-rooms.csv';

export const parseProtectedRooms = parseRoomTable;

/** The shipped table from `dir`, or none with the reason said. */
export function loadProtectedRooms(
  dir: string,
  notify?: (message: string) => void
): ProtectedRooms {
  return loadRoomTable(
    dir,
    PROTECTED_ROOMS_FILE,
    (file, message) => t('notices.world.protectedRooms.readError', { file, message }),
    NO_PROTECTED_ROOMS,
    parseProtectedRooms,
    notify
  );
}
