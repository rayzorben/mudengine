import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { appendRotating } from '../appendRotating';

let directory: string | null = null;

afterEach(() => {
  if (directory !== null) fs.rmSync(directory, { recursive: true, force: true });
  directory = null;
});

describe('a log that starts afresh past its size', () => {
  it('appends until past the limit, then keeps one generation as .1', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rotating-'));
    const file = path.join(directory, 'nested', 'stalls.log');
    await appendRotating(file, 'one\n', 7);
    await appendRotating(file, 'two\n', 7);
    expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\n');
    await appendRotating(file, 'three\n', 7);
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('one\ntwo\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('three\n');
    await appendRotating(file, 'four is longer\n', 7);
    await appendRotating(file, 'five\n', 7);
    // The older generation is replaced, never piled up.
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('three\nfour is longer\n');
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['stalls.log', 'stalls.log.1']);
  });
});
