/**
 * One name for one room description (todo 20261020-2015-01): the first 16 hex
 * of SHA-1 over the text with its whitespace collapsed, as the art run keyed
 * the bundled set (`roomart.py`). Wire text gives the same key: 124 room
 * descriptions in `captures/` hash to keys the set holds. Rooms sharing a
 * description share the picture.
 */
import { createHash } from 'node:crypto';

export const ROOM_KEY = /^[0-9a-f]{16}$/;

export function roomKey(description: string): string {
  const collapsed = description.replace(/\s+/g, ' ').trim();
  return createHash('sha1').update(collapsed, 'utf8').digest('hex').slice(0, 16);
}
