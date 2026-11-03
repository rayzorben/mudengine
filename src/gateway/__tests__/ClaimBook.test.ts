import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClaimBook } from '../ClaimBook';

const brakkle = { realm: 'orohost:2427/GreaterMUD', name: 'Brakkle' };
const KEY = 'K'.repeat(43);
const OTHER = 'O'.repeat(43);
const IDLE = 1000;

let dir: string;
let file: string;
let now: number;
const lines: string[] = [];
/** Every book opened, settled before its folder is removed. */
const books: ClaimBook[] = [];

async function open(most = 10): Promise<ClaimBook> {
  const book = await ClaimBook.open(file, {
    idleMs: IDLE,
    mostPins: most,
    now: () => now,
    log: (line) => lines.push(line)
  });
  books.push(book);
  return book;
}

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claims-'));
  file = path.join(dir, 'claims.json');
  now = 10_000;
  lines.length = 0;
});

afterEach(async () => {
  for (const book of books.splice(0)) await book.settle();
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('the claim book', () => {
  it('pins a name to the first key, and refuses another while it is held', async () => {
    const book = await open();
    expect(book.claim(brakkle, KEY)).toBe('new');
    expect(book.claim({ ...brakkle, name: 'brakkle' }, KEY)).toBe('same');
    expect(book.claim(brakkle, OTHER)).toBe('held');
  });

  it('lets another key take a name its key left alone for the idle time', async () => {
    const book = await open();
    book.claim(brakkle, KEY);
    now += IDLE - 1;
    expect(book.claim(brakkle, OTHER)).toBe('held');
    now += 1;
    expect(book.claim(brakkle, OTHER)).toBe('moved');
    expect(book.claim(brakkle, KEY)).toBe('held');
  });

  it('writes the book whole, readable by its owner only, and reads it back', async () => {
    const book = await open();
    book.claim(brakkle, KEY);
    await book.settle();
    expect((await fs.promises.stat(file)).mode & 0o777).toBe(0o600);
    expect(await fs.promises.readdir(dir)).toEqual(['claims.json']);
    const again = await open();
    expect(again.claim(brakkle, OTHER)).toBe('held');
    expect(lines).toContain(`claims: 1 names read from ${file}`);
  });

  it('refuses a new name once it holds as many as it may, and still answers a held one', async () => {
    const book = await open(1);
    book.claim(brakkle, KEY);
    expect(book.claim({ ...brakkle, name: 'Soul' }, OTHER)).toBe('full');
    expect(book.claim(brakkle, KEY)).toBe('same');
  });

  it('will not start from a file that does not parse, which would free every name', async () => {
    await fs.promises.writeFile(file, '{ not json');
    await expect(open()).rejects.toThrow(/is not JSON/);
    await fs.promises.writeFile(file, JSON.stringify({ v: 9, pins: [] }));
    await expect(open()).rejects.toThrow(/not a claims file/);
  });

  it('leaves out an entry that does not read, and says so', async () => {
    const pin = { peer: brakkle, key: KEY, seen: now - 1 };
    await fs.promises.writeFile(file, JSON.stringify({ v: 1, pins: [pin, { peer: brakkle }] }));
    const book = await open();
    expect(book.claim(brakkle, OTHER)).toBe('held');
    expect(lines.some((line) => line.includes('1 entries'))).toBe(true);
  });
});
