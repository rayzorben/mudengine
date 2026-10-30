/**
 * The bundled room pictures' index (todo 20261021-1417-01), `art/room-index.json`
 * under the shipped resources, written by `npm run build:room-art`: per realm
 * family, the drawing each map/room of that realm's world database shows and
 * how it is turned, and per drawing the key of the description it was drawn
 * from, so a room the realm describes otherwise is not given it. A drawing is
 * made for the room's exits, so a room is found by its number, never by its
 * description alone. A realm with no table answers nothing. Read once, off
 * the main thread's way; an ask before it is read waits on `loaded`.
 */
import fs from 'node:fs';

import { asRealmFamilyPlayed, type RealmFamily } from '../../shared/character';
import { roomTurnOf, type RoomTurn } from '../../shared/roomArt';
import { roomId, type RoomId } from '../../shared/world';
import { errorMessage, isRecord } from '../../shared/values';
import { ROOM_KEY } from './roomKey';

export const ROOM_INDEX_FORMAT = 2;

/** A room's shipped drawing. */
export interface ShippedDrawing {
  key: string;
  turn: RoomTurn;
  /** `roomKey` of the description it was drawn from. */
  described: string;
}

export class ShippedRoomArt {
  private readonly byRoom = new Map<RealmFamily, Map<RoomId, ShippedDrawing>>();
  /** Whether the index has been read, or found unreadable; before that `drawingOf` knows nothing. */
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

  /** The drawing the set made for this realm's map and room, or null; an unknown realm has none. */
  drawingOf(realm: RealmFamily | null, map: number, room: number): ShippedDrawing | null {
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
    const { described, byRoom } = json;
    if (!isRecord(described) || !isRecord(byRoom)) throw new Error('described or byRoom missing');
    let unread = 0;
    // Both realms' tables name the same drawings: one object for each.
    const drawings = new Map<string, ShippedDrawing | null>();
    const shared = (entry: string): ShippedDrawing | null => {
      if (!drawings.has(entry)) drawings.set(entry, drawingIn(entry, described));
      return drawings.get(entry) ?? null;
    };
    for (const [word, table] of Object.entries(byRoom)) {
      const realm = asRealmFamilyPlayed(word);
      if (realm === null || !isRecord(table)) {
        // Kept out rather than refused whole: the other realms' tables still answer.
        say(
          `${file}: no realm is called ${word}; its rooms show only a picture kept on disk or drawn by the art server`
        );
        continue;
      }
      const rooms = new Map<RoomId, ShippedDrawing>();
      for (const [room, entry] of Object.entries(table)) {
        const drawing = typeof entry === 'string' ? shared(entry) : null;
        if (drawing === null) unread++;
        else rooms.set(room, drawing);
      }
      this.byRoom.set(realm, rooms);
    }
    if (unread > 0)
      say(`${file}: ${unread} rooms name a drawing that is not shipped and show no picture`);
  }
}

/** A `byRoom` row as the art run writes it, `<key>:<turn>`: the drawing and its turn code; else null. */
export function shippedRow(entry: string): { key: string; turn: RoomTurn } | null {
  const parts = entry.split(':');
  if (parts.length !== 2) return null;
  const [key = '', code = ''] = parts;
  const turn = /^\d$/.test(code) ? roomTurnOf(Number(code)) : null;
  return ROOM_KEY.test(key) && turn !== null ? { key, turn } : null;
}

/** The row's drawing with the key of the description it was drawn from; else null. */
function drawingIn(entry: string, described: Record<string, unknown>): ShippedDrawing | null {
  const row = shippedRow(entry);
  const text = row === null ? undefined : described[row.key];
  if (row === null || typeof text !== 'string' || !ROOM_KEY.test(text)) return null;
  return { ...row, described: text };
}
