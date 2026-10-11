/**
 * The official realm's protected rooms (`RM_PROTECTED`), shipped as
 * `resources/world/protected-rooms.csv` by `scripts/build-protected-rooms.mjs`
 * because no `.mdb` export carries `Rooms.Attributes`. `buildRealm` marks a
 * room protected where its map, number and name all match a row; a room the
 * table does not name is unknown, never "not protected"
 * (`mudengine-world` › parts/realm.md, todo 87).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from '../../shared/spell-messages';
import { roomId, type RoomId } from '../../shared/world';
import { t } from '../app/i18n';

/** Room name by `map/room`, for every protected room the table names. */
export type ProtectedRooms = ReadonlyMap<RoomId, string>;

export const NO_PROTECTED_ROOMS: ProtectedRooms = new Map();

export const PROTECTED_ROOMS_FILE = 'protected-rooms.csv';

export function parseProtectedRooms(text: string): ProtectedRooms {
  const rooms = new Map<RoomId, string>();
  for (const [map, room, name] of parseCsv(text).slice(1)) {
    const m = Number(map);
    const r = Number(room);
    const named = name?.trim() ?? '';
    if (!Number.isInteger(m) || !Number.isInteger(r) || named.length === 0) continue;
    rooms.set(roomId(m, r), named);
  }
  return rooms;
}

/** The shipped table from `dir`, or none with the reason said. */
export function loadProtectedRooms(
  dir: string,
  notify?: (message: string) => void
): ProtectedRooms {
  const file = path.join(dir, PROTECTED_ROOMS_FILE);
  try {
    return parseProtectedRooms(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    notify?.(
      t('notices.world.protectedRooms.readError', {
        file,
        message: error instanceof Error ? error.message : String(error)
      })
    );
    return NO_PROTECTED_ROOMS;
  }
}
