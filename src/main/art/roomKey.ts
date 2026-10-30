/**
 * One name for one room description (todo 20261020-2015-01): the first 16 hex
 * of SHA-1 over the text with its whitespace collapsed, as the art run keyed
 * the bundled set (`roomart.py`). Wire text gives the same key: 124 room
 * descriptions in `captures/` hash to keys the set holds. The shipped index
 * names each drawing's description by it. A picture the server draws is drawn
 * for one realm's room and its exits (todo 20261021-1417-01), so it is kept
 * under the realm and the room as well.
 */
import { createHash } from 'node:crypto';

import type { RealmFamily } from '../../shared/character';

export const ROOM_KEY = /^[0-9a-f]{16}$/;

export function roomKey(description: string): string {
  return keyOf(collapsed(description));
}

/** A drawn picture's key, as the gateway keeps it (`picture_key`): realm, map/room, description. */
export function drawnRoomKey(
  realm: RealmFamily,
  map: number,
  room: number,
  description: string
): string {
  return keyOf(`${realm}|${map}/${room}|${collapsed(description)}`);
}

function collapsed(description: string): string {
  return description.replace(/\s+/g, ' ').trim();
}

function keyOf(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);
}
