/**
 * The bundled room pictures' index (todo 20261020-2015-01), `art/room-index.json`
 * under the shipped resources, written by `npm run build:room-art`: every
 * key the window has a picture for, and per realm family the key each
 * map/room of that realm's world database was drawn under, so a room shown
 * without its description (brief) still finds its picture. A realm with no
 * table answers nothing, and the room is read instead. Read once, off the
 * main thread's way; an ask before it is read waits on `loaded`.
 */
import fs from 'node:fs';

import { asRealmFamilyPlayed, type RealmFamily } from '../../shared/character';
import { roomId, type RoomId } from '../../shared/world';
import { errorMessage, isRecord } from '../../shared/values';
import { ROOM_KEY } from './roomKey';

export const ROOM_INDEX_FORMAT = 1;

export class ShippedRoomArt {
  private readonly keys = new Set<string>();
  private readonly byRoom = new Map<RealmFamily, Map<RoomId, string>>();
  /** Whether the index has been read, or found unreadable; before that `keyOf` knows nothing. */
  ready = false;
  /** Settled once the index is read, or found unreadable (said); never rejects. */
  readonly loaded: Promise<void>;

  constructor(file: string, say: (message: string) => void) {
    this.loaded = this.read(file, say)
      .catch((error: unknown) => {
        say(`${file}: ${errorMessage(error)}`);
      })
      .finally(() => {
        this.ready = true;
      });
  }

  /** Whether the window has a picture under this key. */
  has(key: string): boolean {
    return this.keys.has(key);
  }

  /** The key the set drew this realm's map and room under, or null; an unknown realm has none. */
  keyOf(realm: RealmFamily | null, map: number, room: number): string | null {
    if (realm === null) return null;
    return this.byRoom.get(realm)?.get(roomId(map, room)) ?? null;
  }

  private async read(file: string, say: (message: string) => void): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    } catch (error) {
      // No set shipped: every room is asked for, which is what a build without one means.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!isRecord(json) || json['format'] !== ROOM_INDEX_FORMAT) {
      throw new Error(`not a format ${ROOM_INDEX_FORMAT} room art index`);
    }
    const { keys, byRoom } = json;
    if (!Array.isArray(keys) || !isRecord(byRoom)) throw new Error('keys or byRoom missing');
    for (const key of keys) if (typeof key === 'string' && ROOM_KEY.test(key)) this.keys.add(key);
    for (const [word, table] of Object.entries(byRoom)) {
      const realm = asRealmFamilyPlayed(word);
      if (realm === null || !isRecord(table)) {
        // Kept out rather than refused whole: the other realms' tables still answer.
        say(`${file}: no realm is called ${word}; its rooms are read with a look instead`);
        continue;
      }
      const rooms = new Map<RoomId, string>();
      for (const [room, key] of Object.entries(table)) {
        if (typeof key === 'string' && this.keys.has(key)) rooms.set(room, key);
      }
      this.byRoom.set(realm, rooms);
    }
  }
}
