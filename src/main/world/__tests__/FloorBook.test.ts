import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EMPTY_CHARACTER, type Room } from '../../../shared/character';
import type { ItemEntity } from '../../../shared/entities';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { setTuning } from '../../app/tuning';
import { FloorBook } from '../FloorBook';

let dir = '';
let file = '';
let said: string[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-floor-'));
  file = path.join(dir, 'memory', 'floor-paradigm.json');
  said = [];
});

afterEach(() => {
  setTuning(DEFAULT_INTERNAL.tuning);
  fs.rmSync(dir, { recursive: true, force: true });
});

const book = (realm = 'paradigm'): FloorBook => new FloorBook(file, realm, (m) => said.push(m));

const item = (name: string): ItemEntity => ({
  name,
  source: 'wire',
  slot: null,
  equipped: false,
  charges: null
});

const room = (over: Partial<Room> = {}): Room => ({
  ...EMPTY_CHARACTER.room,
  map: 1,
  number: 1,
  name: 'Town Gates',
  resolvedBy: 'coordinates',
  confidence: 1,
  ambiguous: 0,
  items: [item('golden pike')],
  ...over
});

const MINUTE = 60_000;

describe('keeping what lies on each floor', () => {
  it('writes down an item seen in a room placed for certain, and reads it back', () => {
    const first = book();
    first.saw(room(), 5);
    first.close();
    expect(book().all).toEqual([
      { room: '1/1', roomName: 'Town Gates', name: 'golden pike', first: 5, at: 5 }
    ]);
    expect(said).toEqual([]);
  });

  it('keeps when it was first seen and moves when it was last seen, past the refresh', () => {
    const kept = book();
    kept.saw(room(), 0);
    kept.saw(room(), MINUTE - 1);
    expect(kept.all[0]).toMatchObject({ first: 0, at: 0 });
    kept.saw(room(), 2 * MINUTE);
    expect(kept.all[0]).toMatchObject({ first: 0, at: 2 * MINUTE });
  });

  it('files nothing against a room the client is not sure of', () => {
    const kept = book();
    kept.saw(room({ ambiguous: 2 }), 1);
    kept.saw(room({ resolvedBy: 'dead-reckoning' }), 2);
    kept.saw(room({ map: null }), 3);
    // Positive control: the same floor in a certain room is written.
    kept.saw(room(), 4);
    expect(kept.all.map((row) => row.at)).toEqual([4]);
  });

  it('drops the longest unseen past the ceiling', () => {
    setTuning({
      ...DEFAULT_INTERNAL.tuning,
      world: { ...DEFAULT_INTERNAL.tuning.world, floorSeenRows: 2 }
    });
    const kept = book();
    kept.saw(room({ number: 1 }), 0);
    kept.saw(room({ number: 2 }), 1);
    // Seen again, so it is no longer the oldest.
    kept.saw(room({ number: 1 }), 2 * MINUTE);
    kept.saw(room({ number: 3 }), 3 * MINUTE);
    expect(kept.all.map((row) => row.room)).toEqual(['1/1', '1/3']);
  });

  it('skips a row it cannot read and keeps the rest', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        realm: 'paradigm',
        seen: [
          { room: '1/1', roomName: 'Town Gates', name: 'golden pike', first: 1, at: 1 },
          { room: '1/2', name: 'broken' }
        ]
      })
    );
    expect(book().all.map((row) => row.room)).toEqual(['1/1']);
    expect(said).toEqual([]);
  });

  it('keeps a file for another realm and reads nothing from it', () => {
    book('paradigm').saw(room(), 1);
    // Written on close by the first store; the second is another realm.
    const other = book('stock');
    expect(other.all).toEqual([]);
  });
});
