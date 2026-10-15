import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extensionOn } from '../../../shared/extensionSwitches';
import { readExtensionSwitches } from '../extensionSwitches';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-switches-'));
  file = path.join(dir, 'default.yaml');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the extension switches read at startup (todo 118)', () => {
  it('reads one switched off, and leaves one it does not name on', () => {
    fs.writeFileSync(file, 'keys: {}\nextensions:\n  planner: false\n  notes: true\n', 'utf8');
    const read = readExtensionSwitches(file);
    if (!('switches' in read)) throw new Error('the file was read');
    const switches = read.switches;
    expect(extensionOn(switches, 'planner')).toBe(false);
    expect(extensionOn(switches, 'notes')).toBe(true);
    expect(extensionOn(switches, 'other')).toBe(true);
  });

  it('is every extension on where the file is absent, and unknown where it does not parse', () => {
    expect(readExtensionSwitches(file)).toEqual({ switches: {} });
    fs.writeFileSync(file, 'extensions: [\n', 'utf8');
    expect(readExtensionSwitches(file)).toHaveProperty('unread');
  });
});
