import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FindBook } from '../FindBook';
import { findKey, findRate, type Sighting } from '../../../shared/finds';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { setTuning } from '../../app/tuning';

let dir = '';
let file = '';
let said: string[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-finds-'));
  file = path.join(dir, 'memory', 'finds-greatermud.json');
  said = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  setTuning(DEFAULT_INTERNAL.tuning);
});

const book = (): FindBook => new FindBook(file, 'greatermud', (m) => said.push(m));

const ROOM = '1/2150';

const found = (over: Partial<Sighting> = {}): Sighting => ({
  roomName: 'Bank of Godfrey',
  name: 'rusty key',
  quantity: null,
  copper: null,
  at: 1_757_000_000_000,
  ...over
});

/** Flushes the deferred write, which is otherwise two seconds away. */
function close(store: FindBook): void {
  store.close();
}

describe('writing a find down', () => {
  it('reports the first, and only the first', () => {
    const store = book();
    expect(store.search(ROOM, [found()])).toHaveLength(1);
    // A lair searched every lap must not announce the same key every lap.
    expect(store.search(ROOM, [found({ at: 2 })])).toEqual([]);
    expect(store.all).toHaveLength(1);
  });

  it('moves a repeat rather than adding one', () => {
    const store = book();
    store.search(ROOM, [found({ at: 1, quantity: 4 })]);
    store.search(ROOM, [found({ at: 9, quantity: 7 })]);
    const [row] = store.all;
    // The record changed even though the news did not: this is what makes
    // "newest first" and "worth searching" legible.
    expect(row).toMatchObject({ at: 9, seen: 2, quantity: 7 });
  });

  it('keeps the same thing in two rooms apart', () => {
    const store = book();
    store.search(ROOM, [found()]);
    store.search('1/2151', [found({ roomName: 'Vault' })]);
    expect(store.all).toHaveLength(2);
  });

  it('drops the oldest at the cap, and forgets its key with it', () => {
    setTuning({
      ...DEFAULT_INTERNAL.tuning,
      records: { ...DEFAULT_INTERNAL.tuning.records, findLimit: 2 }
    });
    const store = book();
    store.search('1/1', [found()]);
    store.search('1/2', [found()]);
    store.search('1/3', [found()]);
    expect(store.all.map((row) => row.room)).toEqual(['1/2', '1/3']);
    // The index went with it, so the dropped row is a *new* find again rather
    // than a repeat of one nothing holds.
    expect(store.search('1/1', [found()])).toHaveLength(1);
  });
});

describe('counting the searches', () => {
  it('counts the search that found nothing, which is what makes a rate', () => {
    const store = book();
    store.search(ROOM, [found()]);
    store.search(ROOM, []);
    store.search(ROOM, []);
    store.search(ROOM, [found()]);
    const [row] = store.all;
    expect(row).toMatchObject({ seen: 2, hits: 2, searched: 4 });
    expect(findRate(row!)).toBe(0.5);
  });

  it("starts a late find against the room's whole count, not its own", () => {
    const store = book();
    for (let i = 0; i < 19; i++) store.search(ROOM, []);
    const [first] = store.search(ROOM, [found()]);
    // One in twenty, not one in one: the misses before it were searches too.
    expect(first).toMatchObject({ hits: 1, searched: 20 });
  });

  it('counts a thing named twice in one search once', () => {
    const store = book();
    store.search(ROOM, [found(), found({ name: 'Rusty Key' })]);
    expect(store.all).toMatchObject([{ hits: 1, searched: 1 }]);
  });

  it('keeps another room out of the count', () => {
    const store = book();
    store.search(ROOM, [found()]);
    store.search('1/2151', []);
    expect(store.all).toMatchObject([{ searched: 1 }]);
  });
});

describe('striking one out', () => {
  it('is the one edit the record accepts, and says whether it did anything', () => {
    const store = book();
    store.search(ROOM, [found()]);
    expect(store.forget(findKey({ room: ROOM, name: 'rusty key' }))).toBe(true);
    expect(store.all).toHaveLength(0);
    expect(store.forget(findKey({ room: ROOM, name: 'rusty key' }))).toBe(false);
  });

  it('does not stop the next search writing it down again', () => {
    const store = book();
    store.search(ROOM, [found()]);
    store.forget(findKey({ room: ROOM, name: 'rusty key' }));
    expect(store.search(ROOM, [found()])).toHaveLength(1);
  });
});

describe('the file', () => {
  it('survives a restart, atomically and with no temp file left behind', () => {
    const store = book();
    store.search(ROOM, [found({ quantity: 4, copper: 4, name: '4 copper farthings' })]);
    store.search(ROOM, []);
    close(store);

    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(book().all).toMatchObject([
      { name: '4 copper farthings', copper: 4, seen: 1, hits: 1, searched: 2 }
    ]);
    // The count is the room's, kept once rather than on every row.
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.searches).toEqual({ [ROOM]: 2 });
    expect(written.finds[0]).not.toHaveProperty('searched');
  });

  it('is ignored, not deleted, when it belongs to another realm', () => {
    const store = book();
    store.search(ROOM, [found()]);
    close(store);

    const other = new FindBook(file, 'paradigm', (m) => said.push(m));
    expect(other.all).toHaveLength(0);
    // Still on disk: somebody who switches back gets it back.
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).finds).toHaveLength(1);
  });

  it('refuses a damaged envelope out loud, and keeps the file', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 99, realm: 'greatermud', finds: [] }), 'utf8');
    expect(book().all).toHaveLength(0);
    expect(said.join(' ')).toMatch(/not a find log/);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('refuses a damaged row out loud, and keeps the file', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 2, realm: 'greatermud', searches: {}, finds: [{ room: '1/1' }] }),
      'utf8'
    );
    expect(book().all).toHaveLength(0);
    expect(said.join(' ')).toMatch(/not a find log/);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('refuses a row found more often than its room was searched', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const row = { room: ROOM, ...found(), seen: 3, hits: 3 };
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 2, realm: 'greatermud', searches: { [ROOM]: 2 }, finds: [row] }),
      'utf8'
    );
    expect(book().all).toHaveLength(0);
    expect(said.join(' ')).toMatch(/not a find log/);
  });

  it('brings a version 1 log up once, with no rate for what it held', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const row = { room: ROOM, ...found(), seen: 9 };
    const original = JSON.stringify({ version: 1, realm: 'greatermud', finds: [row] });
    fs.writeFileSync(file, original, 'utf8');

    const store = book();
    // Nine finds and no count of the searches that missed: no rate, not 100%.
    expect(store.all).toMatchObject([{ seen: 9, hits: 0, searched: 0 }]);
    expect(said.join(' ')).toMatch(/now counts searches/);
    expect(fs.readFileSync(`${file}.bak`, 'utf8')).toBe(original);

    close(store);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ version: 2, searches: {} });
  });

  it('reports unreadable JSON and keeps it', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json', 'utf8');
    expect(book().all).toHaveLength(0);
    expect(said.join(' ')).toMatch(/Could not read/);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('is not written at all until there is something to write', () => {
    close(book());
    expect(fs.existsSync(file)).toBe(false);
  });
});
