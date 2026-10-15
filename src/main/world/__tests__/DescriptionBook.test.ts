import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EMPTY_CHARACTER, type Room } from '../../../shared/character';
import { DescriptionBook } from '../DescriptionBook';

let dir = '';
let file = '';
let said: string[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-descriptions-'));
  file = path.join(dir, 'memory', 'descriptions-paradigm.json');
  said = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const book = (realm = 'paradigm'): DescriptionBook =>
  new DescriptionBook(file, realm, (m) => said.push(m));

/** What the file holds once the store has written: what the next pass over the world reads. */
const written = (kept: DescriptionBook): unknown[] => {
  kept.close();
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')).rooms as unknown[]) : [];
};

const room = (over: Partial<Room> = {}): Room => ({
  ...EMPTY_CHARACTER.room,
  map: 1,
  number: 1,
  name: 'Town Gates',
  description: 'You are before the massive town gates of Silvermere.',
  resolvedBy: 'coordinates',
  confidence: 1,
  ambiguous: 0,
  ...over
});

describe('keeping what each room says', () => {
  it('writes down a room placed for certain, and reads it back', () => {
    const first = book();
    first.saw(room(), 5);
    first.close();
    // Read back by a second store, which writes what it loaded when asked.
    const second = book();
    second.saw(
      room({ map: 1, number: 2, name: 'Estwall Street', description: 'A cobbled street.' }),
      6
    );
    expect(written(second)).toEqual([
      {
        room: '1/1',
        name: 'Town Gates',
        text: 'You are before the massive town gates of Silvermere.',
        at: 5
      },
      { room: '1/2', name: 'Estwall Street', text: 'A cobbled street.', at: 6 }
    ]);
    expect(said).toEqual([]);
  });

  it('skips a room it guessed, a lost one and an ambiguous one', () => {
    const kept = book();
    kept.saw(room({ resolvedBy: 'dead-reckoning' }), 1);
    kept.saw(room({ map: null, number: null }), 2);
    kept.saw(room({ ambiguous: 3 }), 3);
    kept.saw(room({ description: null }), 4);
    expect(written(kept)).toEqual([]);
  });

  it('writes again only when a room says something new', () => {
    const kept = book();
    kept.saw(room(), 1);
    kept.saw(room(), 2);
    expect(written(kept)[0]).toMatchObject({ at: 1 });
    kept.saw(room({ description: 'The gates are shut.' }), 3);
    expect(written(kept)[0]).toMatchObject({ text: 'The gates are shut.', at: 3 });
  });

  it("keeps another realm's file and reads nothing from it", () => {
    const other = book('majormud');
    other.saw(room(), 1);
    other.close();
    const mine = book();
    mine.saw(room({ number: 9 }), 2);
    expect(written(mine)).toEqual([expect.objectContaining({ room: '1/9' })]);
  });
});
