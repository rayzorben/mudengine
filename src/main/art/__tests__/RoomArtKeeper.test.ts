import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PictureCache } from '../pictureCache';
import { RoomArtKeeper } from '../RoomArtKeeper';
import { roomKey } from '../roomKey';
import { ShippedRoomArt } from '../ShippedRoomArt';
import {
  EMPTY_CHARACTER,
  type CharacterState,
  type RealmFamily,
  type Room
} from '../../../shared/character';
import type { RoomArtRequest, RoomArtResult, RoomArtView } from '../../../shared/roomArt';

const PICTURE = new Uint8Array([0x52, 0x49, 0x46, 0x46, 9]);
const MARBLE = 'This narrow passageway is made of smooth white marble.';
const MARBLE_KEY = roomKey(MARBLE);
const CRYPT = 'Unlit torches line the walls of this ten foot wide stone hallway.';
const CRYPT_KEY = roomKey(CRYPT);

/* Todo 20261020-2015-01: the room's picture, shipped, kept or asked for. */
describe('the picture of the room the character is in', () => {
  let dir: string;
  let asked: RoomArtRequest[];
  let published: RoomArtView[];
  let said: string[];
  let enabled: boolean;
  let answer: RoomArtResult;
  let shipped: ShippedRoomArt;

  const room = (
    map: number,
    number: number,
    description: string | null,
    more: Partial<Room> = {}
  ): Room => ({
    ...EMPTY_CHARACTER.room,
    map,
    number,
    name: 'Marble Passage',
    description,
    ambiguous: 0,
    ...more
  });
  const inRoom = (one: Room, realm: RealmFamily | null = 'greatermud'): CharacterState => ({
    ...structuredClone(EMPTY_CHARACTER),
    phase: 'in-game',
    realm,
    room: one
  });

  const keeper = () => {
    const [ownAsked, ownPublished, ownSaid] = [asked, published, said];
    return new RoomArtKeeper({
      shipped,
      source: {
        roomArtOf: async (request) => {
          ownAsked.push(request);
          return answer;
        }
      },
      cache: new PictureCache(path.join(dir, 'rooms'), () => 10),
      enabled: () => enabled,
      publish: (view) => ownPublished.push(view),
      say: (message) => ownSaid.push(message)
    });
  };
  const until = async (done: () => boolean): Promise<void> => {
    const deadline = Date.now() + 4000;
    while (!done()) {
      if (Date.now() > deadline) throw new Error('waited four seconds for the keeper');
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };
  const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-art-'));
    fs.writeFileSync(
      path.join(dir, 'room-index.json'),
      JSON.stringify({
        format: 1,
        keys: [MARBLE_KEY],
        byRoom: { greatermud: { '1/78': MARBLE_KEY } }
      })
    );
    shipped = new ShippedRoomArt(path.join(dir, 'room-index.json'), (message) => {
      throw new Error(message);
    });
    asked = [];
    published = [];
    said = [];
    enabled = true;
    answer = { kind: 'picture', bytes: PICTURE, type: 'image/webp' };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('shows a shipped picture by its description, asking nothing', async () => {
    const one = keeper();
    one.observe(inRoom(room(1, 78, MARBLE)));
    await until(() => one.current().picture !== null);
    expect(one.current().picture).toEqual({ kind: 'shipped', key: MARBLE_KEY });
    expect(asked).toEqual([]);
    one.dispose();
  });

  it('shows a shipped picture for the map and room when brief printed no description', async () => {
    const one = keeper();
    one.observe(inRoom(room(1, 78, null)));
    await until(() => one.current().picture !== null);
    expect(one.current().picture).toEqual({ kind: 'shipped', key: MARBLE_KEY });
    one.observe(inRoom(room(1, 79, null)));
    await until(() => one.current().picture === null);
    // Another realm's numbering is another realm's room: nothing is guessed from this table.
    one.observe(inRoom(room(1, 78, null), 'majormud'));
    await settled();
    expect(one.current().picture).toBeNull();
    expect(asked).toEqual([]);
    one.dispose();
  });

  it('asks once for an unknown description, keeps the drawing and shows it from disk next time', async () => {
    const one = keeper();
    one.observe(inRoom(room(1, 1710, CRYPT)));
    one.observe(inRoom(room(1, 1710, CRYPT, { light: 'dimly lit' })));
    await until(() => one.current().picture?.kind === 'drawn');
    expect(asked).toEqual([{ map: 1, room: 1710, name: 'Marble Passage', description: CRYPT }]);
    expect(one.current().picture).toMatchObject({ kind: 'drawn', key: CRYPT_KEY });
    one.dispose();
    const again = keeper();
    again.observe(inRoom(room(2, 5, CRYPT)));
    await until(() => again.current().picture?.kind === 'drawn');
    expect(asked).toHaveLength(1);
    again.dispose();
  });

  it('asks nothing with the switch off, for an uncertain room, or with a description still unread', async () => {
    const one = keeper();
    enabled = false;
    one.observe(inRoom(room(1, 1710, CRYPT)));
    await settled();
    one.observe(inRoom(room(1, 1710, CRYPT, { light: 'dimly lit' })));
    await settled();
    one.observe(inRoom(room(1, 1710, CRYPT, { ambiguous: 2 })));
    await settled();
    enabled = true;
    one.observe(inRoom(room(1, 1710, CRYPT, { ambiguous: 2 })));
    await settled();
    one.observe(inRoom(room(1, 1710, null)));
    await settled();
    expect(asked).toEqual([]);
    expect(one.current().picture).toBeNull();
    one.dispose();
  });

  it('says a refusal once and does not ask again until the server was unreachable and the realm re-entered', async () => {
    const one = keeper();
    answer = { kind: 'refused', reason: 'not a room any world database has' };
    one.observe(inRoom(room(1, 1710, CRYPT)));
    await until(() => said.length === 1);
    one.observe(inRoom(room(1, 1711, MARBLE)));
    one.observe(inRoom(room(1, 1710, CRYPT)));
    await settled();
    expect(asked).toHaveLength(1);
    answer = { kind: 'unreachable', reason: 'down' };
    one.observe(inRoom(room(1, 1712, 'Somewhere else.')));
    await until(() => said.length === 2);
    one.observe({ ...inRoom(room(1, 1712, 'Somewhere else.')), phase: 'unknown' });
    one.observe(inRoom(room(1, 1712, 'Somewhere else.')));
    await until(() => asked.length === 3);
    // The switch turned off and on again forgives a refusal too.
    enabled = false;
    one.observe(inRoom(room(1, 1710, CRYPT)));
    await settled();
    enabled = true;
    answer = { kind: 'picture', bytes: PICTURE, type: 'image/webp' };
    one.observe(inRoom(room(1, 1710, CRYPT, { light: 'dimly lit' })));
    await until(() => asked.length === 4);
    one.dispose();
  });

  it('holds a second room off while one is being drawn, then decides it', async () => {
    let finish: (() => void) | null = null;
    const slow = keeper();
    const one = new RoomArtKeeper({
      shipped,
      source: {
        roomArtOf: (request) =>
          new Promise((resolve) => {
            asked.push(request);
            finish = () => resolve(answer);
          })
      },
      cache: new PictureCache(path.join(dir, 'rooms'), () => 10),
      enabled: () => enabled,
      publish: (view) => published.push(view),
      say: (message) => said.push(message)
    });
    slow.dispose();
    one.observe(inRoom(room(1, 1710, CRYPT)));
    await until(() => asked.length === 1);
    one.observe(inRoom(room(1, 1712, 'Somewhere else.')));
    await settled();
    expect(asked).toHaveLength(1);
    finish!();
    await until(() => asked.length === 2);
    expect(asked[1]).toMatchObject({ room: 1712 });
    // The drawing of the room left shows nowhere; the room stood in is still being drawn.
    expect(published.every((view) => view.picture?.key !== CRYPT_KEY)).toBe(true);
    one.dispose();
  });
});
