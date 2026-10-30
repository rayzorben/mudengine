import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});
