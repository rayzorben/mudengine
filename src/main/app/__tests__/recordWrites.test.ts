import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecordWrites } from '../recordWrites';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-writes-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = (file: string): string | null =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
const never = (error: unknown): void => {
  throw error;
};

/** Resolves once `count` background writes have cleaned up their temporaries: the last step `writeWhole` takes. */
function settled(count: number): () => Promise<void> {
  const rm = vi.spyOn(fs.promises, 'rm');
  return () => vi.waitFor(() => expect(rm).toHaveBeenCalledTimes(count));
}

describe('a record written in the background', () => {
  it('lands the newest text, never an older one after it', async () => {
    const file = path.join(dir, 'record.json');
    const writes = new RecordWrites(file, never);
    writes.write('one');
    writes.write('two');
    writes.write('three');
    // Not on the thread that called: nothing is there until the write lands.
    expect(read(file)).toBeNull();
    await vi.waitFor(() => expect(read(file)).toBe('three'));
  });

  it('writes at once on a close the text still out, and the out write leaves it standing', async () => {
    const file = path.join(dir, 'record.json');
    const done = settled(1);
    const writes = new RecordWrites(file, never);
    writes.write('only');
    writes.close();
    expect(read(file)).toBe('only');
    await done();
    expect(read(file)).toBe('only');
  });

  it('writes at once on a close what was waiting, and every write after it', async () => {
    const file = path.join(dir, 'record.json');
    const done = settled(1);
    const writes = new RecordWrites(file, never);
    writes.write('playing');
    writes.write('waiting');
    writes.close();
    expect(read(file)).toBe('waiting');
    writes.write('after the close');
    expect(read(file)).toBe('after the close');
    // The write that was out has settled, and the newest text still stands.
    await done();
    expect(read(file)).toBe('after the close');
  });

  it('tells the store a write that failed', async () => {
    // A directory where the file goes: the rename onto it fails.
    const file = path.join(dir, 'record.json');
    fs.mkdirSync(file);
    const failed = vi.fn();
    new RecordWrites(file, failed).write('x');
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
  });
});
