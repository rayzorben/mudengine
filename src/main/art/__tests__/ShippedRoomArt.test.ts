import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { roomKey } from '../roomKey';
import { ShippedRoomArt } from '../ShippedRoomArt';

const DRAWING = '0123456789abcdef';
const DESCRIBED = 'fedcba9876543210';

/* Todo 20261021-1417-01: the shipped index, a drawing and its turn per room. */
describe('the shipped room art index', () => {
  let dir: string;
  let said: string[];

  const read = async (index: unknown): Promise<ShippedRoomArt> => {
    const file = path.join(dir, 'room-index.json');
    fs.writeFileSync(file, JSON.stringify(index));
    const shipped = new ShippedRoomArt(file, (message) => said.push(message));
    await shipped.loaded;
    return shipped;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-index-'));
    said = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads each turn code as mirrored first, then quarter turns clockwise', async () => {
    const byRoom = Object.fromEntries(
      [0, 1, 2, 3, 4, 5, 6, 7].map((code) => [`1/${code}`, `${DRAWING}:${code}`])
    );
    const shipped = await read({
      format: 2,
      described: { [DRAWING]: DESCRIBED },
      byRoom: { greatermud: byRoom }
    });
    expect([0, 3, 4, 7].map((code) => shipped.drawingOf('greatermud', 1, code)?.turn)).toEqual([
      { quarters: 0, mirrored: false },
      { quarters: 3, mirrored: false },
      { quarters: 0, mirrored: true },
      { quarters: 3, mirrored: true }
    ]);
    expect(shipped.drawingOf('greatermud', 1, 5)).toEqual({
      key: DRAWING,
      turn: { quarters: 1, mirrored: true },
      described: DESCRIBED
    });
    expect(said).toEqual([]);
  });

  it('shows nothing for a row it cannot read, and says how many', async () => {
    const shipped = await read({
      format: 2,
      described: { [DRAWING]: DESCRIBED },
      byRoom: {
        greatermud: {
          '1/1': `${DRAWING}:8`,
          '1/2': 'not-a-key:0',
          '1/3': `${'a'.repeat(16)}:0`,
          '1/4': `${DRAWING}:2`,
          '1/5': `${DRAWING}:2:0`
        },
        nowhere: { '1/1': `${DRAWING}:0` }
      }
    });
    expect([1, 2, 3, 5].map((room) => shipped.drawingOf('greatermud', 1, room))).toEqual([
      null,
      null,
      null,
      null
    ]);
    expect(shipped.drawingOf('greatermud', 1, 4)?.key).toBe(DRAWING);
    expect(shipped.drawingOf('paradigm', 1, 4)).toBeNull();
    expect(shipped.drawingOf(null, 1, 4)).toBeNull();
    expect(said).toHaveLength(2);
  });

  it('refuses an index of another format whole, and says so', async () => {
    const shipped = await read({ format: 1, keys: [DRAWING], byRoom: {} });
    expect(shipped.ready).toBe(true);
    expect(shipped.drawingOf('greatermud', 1, 1)).toBeNull();
    expect(said).toHaveLength(1);
  });

  /*
   * MajorMUD takes Gmud's drawing at the same number (2026-10-31). The text is
   * what The Major BBS printed for Newhaven, Village Entrance on `l`, from
   * Soul's `descriptions-majormud-bbs.themajorbbs.com-23.json` on the OCI host.
   */
  it('ships MajorMUD the drawing made from the description its server prints', async () => {
    const shipped = new ShippedRoomArt(
      path.join(__dirname, '../../../../resources/art/room-index.json'),
      (message) => said.push(message)
    );
    await shipped.loaded;
    const majormud = shipped.drawingOf('majormud', 1, 2140);
    expect(majormud).toEqual(shipped.drawingOf('greatermud', 1, 2140));
    expect(majormud?.described).toBe(
      roomKey(
        'Welcome to Newhaven! You are standing at the crude wooden gates of the village ' +
          'entrance, in the middle of a dusty path. A low wooden palisade surrounds the ' +
          'village, to protect against creatures of the night and random raiders. You can ' +
          'see small buildings to the north and south, and a dusty path that leads to the ' +
          'west and southeast.'
      )
    );
    // 5/3 is Tournament Arena in MajorMUD and Westwall Street in Gmud: another room.
    expect(shipped.drawingOf('greatermud', 5, 3)).not.toBeNull();
    expect(shipped.drawingOf('majormud', 5, 3)).toBeNull();
    expect(said).toEqual([]);
  });
});
