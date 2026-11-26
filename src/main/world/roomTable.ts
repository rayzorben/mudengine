/**
 * A shipped `map,room,name` table (`protected-rooms.csv`,
 * `blank-room-names.csv`): parsed once here so the two tables read rows and
 * report an unreadable file the same way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from '../../shared/spell-messages';
import { roomId, type RoomId } from '../../shared/world';

/** Room name by `map/room`. */
export type RoomTable = ReadonlyMap<RoomId, string>;

export function parseRoomTable(text: string): RoomTable {
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

/**
 * `file` from `dir`, or `none` with the reason said through `notify`.
 * `describe` builds the sentence, so each table keeps its own notice key.
 */
export function loadRoomTable(
  dir: string,
  file: string,
  describe: (file: string, message: string) => string,
  none: RoomTable,
  notify?: (message: string) => void
): RoomTable {
  const where = path.join(dir, file);
  try {
    return parseRoomTable(fs.readFileSync(where, 'utf8'));
  } catch (error) {
    notify?.(describe(where, error instanceof Error ? error.message : String(error)));
    return none;
  }
}
