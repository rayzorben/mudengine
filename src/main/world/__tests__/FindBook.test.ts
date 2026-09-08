import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FindBook } from '../FindBook';
import { findKey, type Find } from '../../../shared/finds';
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

const found = (over: Partial<Omit<Find, 'seen'>> = {}): Omit<Find, 'seen'> => ({
  room: '1/2150',
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
    expect(store.record(found())).not.toBeNull();
    // A lair searched every lap must not announce the same key every lap.
    expect(store.record(found({ at: 2 }))).toBeNull();
    expect(store.all).toHaveLength(1);
  });

  it('moves a repeat rather than adding one', () => {
    const store = book();
    store.record(found({ at: 1, quantity: 4 }));
    store.record(found({ at: 9, quantity: 7 }));
    const [row] = store.all;
    // The record changed even though the news did not: this is what makes
    // "newest first" and "worth searching" legible.
    expect(row).toMatchObject({ at: 9, seen: 2, quantity: 7 });
  });

  it('keeps the same thing in two rooms apart', () => {
    const store = book();
    store.record(found());
    store.record(found({ room: '1/2151', roomName: 'Vault' }));
    expect(store.all).toHaveLength(2);
  });

  it('drops the oldest at the cap, and forgets its key with it', () => {
    setTuning({
      ...DEFAULT_INTERNAL.tuning,
      records: { ...DEFAULT_INTERNAL.tuning.records, findLimit: 2 }
    });
    const store = book();
    store.record(found({ room: '1/1' }));
    store.record(found({ room: '1/2' }));
    store.record(found({ room: '1/3' }));
    expect(store.all.map((row) => row.room)).toEqual(['1/2', '1/3']);
    // The index went with it, so the dropped row is a *new* find again rather
    // than a repeat of one nothing holds.
    expect(store.record(found({ room: '1/1' }))).not.toBeNull();
  });
});

describe('striking one out', () => {
  it('is the one edit the record accepts, and says whether it did anything', () => {
    const store = book();
    store.record(found());
    expect(store.forget(findKey(found()))).toBe(true);
    expect(store.all).toHaveLength(0);
    expect(store.forget(findKey(found()))).toBe(false);
  });

  it('does not stop the next search writing it down again', () => {
    const store = book();
    store.record(found());
    store.forget(findKey(found()));
    expect(store.record(found())).not.toBeNull();
  });
});

describe('the file', () => {
  it('survives a restart, atomically and with no temp file left behind', () => {
    const store = book();
    store.record(found({ quantity: 4, copper: 4, name: '4 copper farthings' }));
    close(store);

    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(book().all).toMatchObject([{ name: '4 copper farthings', copper: 4, seen: 1 }]);
  });

  it('is ignored, not deleted, when it belongs to another realm', () => {
    const store = book();
    store.record(found());
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
      JSON.stringify({ version: 1, realm: 'greatermud', finds: [{ room: '1/1' }] }),
      'utf8'
    );
    expect(book().all).toHaveLength(0);
    expect(said.join(' ')).toMatch(/not a find log/);
    expect(fs.existsSync(file)).toBe(true);
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
