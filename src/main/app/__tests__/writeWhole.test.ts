import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeWhole, writeWholeSync, writtenOver } from '../writeWhole';

let dir = '';
let file = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-whole-'));
  file = path.join(dir, 'deep', 'record.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Whatever beside the file is not the file: a temporary left behind. */
const leftBeside = (): string[] =>
  fs.readdirSync(path.dirname(file)).filter((name) => name !== path.basename(file));

describe('a file written whole', () => {
  it('writes the file and its directory, and leaves nothing beside it', async () => {
    await writeWhole(file, 'one');
    expect(fs.readFileSync(file, 'utf8')).toBe('one');
    writeWholeSync(file, 'two');
    expect(fs.readFileSync(file, 'utf8')).toBe('two');
    expect(leftBeside()).toEqual([]);
  });

  it('writes a secret with the mode asked for', async () => {
    await writeWhole(file, 'key', { mode: 0o600 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('throws a failed write, leaving what was there and no temporary', async () => {
    writeWholeSync(file, 'kept');
    const blocked = path.join(dir, 'deep', 'blocked');
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, 'inside'), 'x');
    await expect(writeWhole(blocked, 'lost')).rejects.toThrow();
    expect(() => writeWholeSync(blocked, 'lost')).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('kept');
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['blocked', 'record.json']);
  });

  it('leaves the file as it stands when the write is no longer wanted', async () => {
    writeWholeSync(file, 'newer');
    await writeWhole(file, 'older', { stillWanted: () => false });
    expect(fs.readFileSync(file, 'utf8')).toBe('newer');
    expect(leftBeside()).toEqual([]);
  });

  it('gives two writes of one file at once a temporary each, so neither loses its rename', async () => {
    // One shared temporary: the first rename takes it, and the second fails ENOENT.
    await Promise.all([writeWhole(file, 'a'.repeat(100_000)), writeWhole(file, 'b')]);
    expect(['a'.repeat(100_000), 'b']).toContain(fs.readFileSync(file, 'utf8'));
    expect(leftBeside()).toEqual([]);
  });

  it('names its temporary as a dotfile that says which file it was written over', () => {
    expect(writtenOver('.0001.folds.json.4242-7.tmp')).toBe('0001.folds.json');
    expect(writtenOver('0001.folds.json')).toBeNull();
    expect(writtenOver('.hidden')).toBeNull();
  });
});
