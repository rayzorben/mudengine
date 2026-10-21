import { describe, expect, it } from 'vitest';

import { ROOM_KEY, roomKey } from '../roomKey';

/*
 * Todo 20261020-2015-01: the key the bundled set is filed under. Marble
 * Passage as captures/002 prints it; `51dedcf6d3038fdb` is its picture in
 * `mdb/room-art.zip`'s index.
 */
const MARBLE_PASSAGE =
  '    This narrow passageway is made of smooth white marble, polished to a\n' +
  'mirrorlike shine. Your every sound echoes down its length like a thunderclap,\n' +
  'it is so silent here. The passage slopes downwards at a steady angle, heading\n' +
  'into the bowels of the earth.';

describe('a room description key', () => {
  it('is the first 16 hex of SHA-1 over the text with its whitespace collapsed', () => {
    expect(roomKey(MARBLE_PASSAGE)).toBe('51dedcf6d3038fdb');
    expect(roomKey(MARBLE_PASSAGE.replace(/\s+/g, ' ').trim())).toBe('51dedcf6d3038fdb');
    expect(roomKey(MARBLE_PASSAGE)).toMatch(ROOM_KEY);
  });

  it('tells one description from another', () => {
    expect(roomKey('A dark room.')).not.toBe(roomKey('A dark room'));
  });
});
