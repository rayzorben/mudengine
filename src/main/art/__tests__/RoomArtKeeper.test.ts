import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PictureCache } from '../pictureCache';
import { RoomArtKeeper } from '../RoomArtKeeper';
import { drawnRoomKey, roomKey } from '../roomKey';
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
/** A picture the server drew for GreaterMUD's map 1 room and its exits. */
const drawnKey = (number: number, text: string): string =>
  drawnRoomKey('greatermud', 1, number, text);
/** The drawing made for 1/78's description and exits, laid on mirrored and turned once. */
const DRAWING = '0123456789abcdef';
const SHIPPED = { kind: 'shipped', key: DRAWING, turn: { quarters: 1, mirrored: true } };

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

  /** Every keeper a test made, so its folder goes only once their writes have landed. */
  let made: RoomArtKeeper[];

  const keeper = () => {
    const [ownAsked, ownPublished, ownSaid] = [asked, published, said];
    const one = new RoomArtKeeper({
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
    made.push(one);
    return one;
  };
  const until = async (done: () => boolean): Promise<void> => {
    const deadline = Date.now() + 4000;
    while (!done()) {
      if (Date.now() > deadline) throw new Error('waited four seconds for the keeper');
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-art-'));
    fs.writeFileSync(
      path.join(dir, 'room-index.json'),
      JSON.stringify({
        format: 2,
        described: { [DRAWING]: MARBLE_KEY },
        byRoom: { greatermud: { '1/78': `${DRAWING}:5` } }
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
    made = [];
  });
  // A drawing is written to the store after it shows; removing the folder before
  // that write landed failed with ENOTEMPTY (CI, 2026-11-03).
  afterEach(async () => {
    await Promise.all(made.map((one) => one.settled()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shows the drawing made for the room, turned, when it reads as drawn, asking nothing', async () => {
    const one = keeper();
    one.observe(inRoom(room(1, 78, MARBLE)));
    await until(() => one.current().picture !== null);
    expect(one.current().picture).toEqual(SHIPPED);
    expect(asked).toEqual([]);
    one.dispose();
  });

  it('gives the drawing to no other description at that number, nor the description elsewhere', async () => {
    const one = keeper();
    one.observe(inRoom(room(1, 78, CRYPT)));
    await until(() => one.current().picture?.kind === 'drawn');
    expect(one.current().picture).toMatchObject({ key: drawnKey(78, CRYPT) });
    // Drawn for 1/78's exits: the same words in a room with other exits are asked for.
    one.observe(inRoom(room(1, 1711, MARBLE)));
    await until(() => one.current().picture?.key === drawnKey(1711, MARBLE));
    expect(asked.map((request) => request.room)).toEqual([78, 1711]);
    one.dispose();
  });

  it('shows a shipped picture for the map and room when brief printed no description', async () => {
    const one = keeper();
    one.observe(inRoom(room(1, 78, null)));
    await until(() => one.current().picture !== null);
    expect(one.current().picture).toEqual(SHIPPED);
    one.observe(inRoom(room(1, 79, null)));
    await until(() => one.current().picture === null);
    // Another realm's numbering is another realm's room: nothing is guessed from this table.
    one.observe(inRoom(room(1, 78, null), 'majormud'));
    await one.settled();
    expect(one.current().picture).toBeNull();
    expect(asked).toEqual([]);
    one.dispose();
  });

  it('asks once for an unknown description, keeps the drawing and shows it from disk next time', async () => {
    const one = keeper();
    one.observe(inRoom(room(1, 1710, CRYPT)));
    one.observe(inRoom(room(1, 1710, CRYPT, { light: 'dimly lit' })));
    await until(() => one.current().picture?.kind === 'drawn');
    expect(asked).toEqual([
      { realm: 'greatermud', map: 1, room: 1710, name: 'Marble Passage', description: CRYPT }
    ]);
    expect(one.current().picture).toMatchObject({ kind: 'drawn', key: drawnKey(1710, CRYPT) });
    one.dispose();
    const again = keeper();
    again.observe(inRoom(room(1, 1710, CRYPT)));
    await until(() => again.current().picture?.kind === 'drawn');
    expect(asked).toHaveLength(1);
    // Drawn for 1/1710's exits: the same words in another room, or another realm's, are asked for.
    again.observe(inRoom(room(1, 1711, CRYPT)));
    await until(() => asked.length === 2);
    again.observe(inRoom(room(1, 1711, CRYPT), 'paradigm'));
    await until(() => asked.length === 3);
    expect(asked[2]).toMatchObject({ realm: 'paradigm', room: 1711 });
    again.dispose();
  });

  it('asks nothing for a room on an unknown realm: the server has no world to read its exits from', async () => {
    const one = keeper();
    one.observe(inRoom(room(1, 1710, CRYPT), null));
    await one.settled();
    expect(asked).toEqual([]);
    expect(one.current().picture).toBeNull();
    one.dispose();
  });

  it('asks nothing with the switch off, for an uncertain room, or with a description still unread', async () => {
    const one = keeper();
    enabled = false;
    one.observe(inRoom(room(1, 1710, CRYPT)));
    await one.settled();
    one.observe(inRoom(room(1, 1710, CRYPT, { light: 'dimly lit' })));
    await one.settled();
    one.observe(inRoom(room(1, 1710, CRYPT, { ambiguous: 2 })));
    await one.settled();
    enabled = true;
    one.observe(inRoom(room(1, 1710, CRYPT, { ambiguous: 2 })));
    await one.settled();
    one.observe(inRoom(room(1, 1710, null)));
    await one.settled();
    expect(asked).toEqual([]);
    expect(one.current().picture).toBeNull();
    one.dispose();
  });

  it('says a refusal once and does not ask again until the server was unreachable and the realm re-entered', async () => {
    const one = keeper();
    answer = { kind: 'refused', reason: 'not a room any world database has' };
    one.observe(inRoom(room(1, 1710, CRYPT)));
    await until(() => said.length === 1);
    one.observe(inRoom(room(1, 78, MARBLE)));
    one.observe(inRoom(room(1, 1710, CRYPT)));
    await one.settled();
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
    await one.settled();
    enabled = true;
    answer = { kind: 'picture', bytes: PICTURE, type: 'image/webp' };
    one.observe(inRoom(room(1, 1710, CRYPT, { light: 'dimly lit' })));
    await until(() => asked.length === 4);
    one.dispose();
  });

  it('holds a second room off while one is being drawn, then decides it', async () => {
    let finish: (() => void) | null = null;
    const slow = keeper();
    const cache = new PictureCache(path.join(dir, 'rooms'), () => 10);
    // Each key looked for in the store: the look comes just before the decision to ask.
    const looked: string[] = [];
    const look = cache.get.bind(cache);
    cache.get = async (key) => {
      const kept = await look(key);
      looked.push(key);
      return kept;
    };
    const one = new RoomArtKeeper({
      shipped,
      source: {
        roomArtOf: (request) =>
          new Promise((resolve) => {
            asked.push(request);
            finish = () => resolve(answer);
          })
      },
      cache,
      enabled: () => enabled,
      publish: (view) => published.push(view),
      say: (message) => said.push(message)
    });
    made.push(one);
    slow.dispose();
    one.observe(inRoom(room(1, 1710, CRYPT)));
    await until(() => asked.length === 1);
    one.observe(inRoom(room(1, 1712, 'Somewhere else.')));
    await until(() => looked.includes(drawnKey(1712, 'Somewhere else.')));
    expect(asked).toHaveLength(1);
    finish!();
    await until(() => asked.length === 2);
    expect(asked[1]).toMatchObject({ room: 1712 });
    // The drawing of the room left shows nowhere; the room stood in is still being drawn.
    expect(published.every((view) => view.picture?.key !== drawnKey(1710, CRYPT))).toBe(true);
    finish!();
    one.dispose();
  });
});
