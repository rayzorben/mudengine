import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClosedTabs } from '../ClosedTabs';

let dir = '';
let file = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-closed-'));
  file = path.join(dir, 'closed-tabs.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the tabs a player closed', () => {
  it('are still closed in the next run', () => {
    const first = new ClosedTabs();
    first.open(file);
    first.add('thorn');
    first.add('soul');
    first.delete('soul');

    const second = new ClosedTabs();
    second.open(file);
    expect(second.has('thorn')).toBe(true);
    expect(second.has('soul')).toBe(false);
  });

  it('start empty with no file, without a word', () => {
    const said: string[] = [];
    const closed = new ClosedTabs((message) => said.push(message));
    closed.open(file);
    expect(closed.all()).toEqual([]);
    expect(said).toEqual([]);
  });

  it('say a file that does not parse and show every character', () => {
    fs.writeFileSync(file, '{ nope');
    const said: string[] = [];
    const closed = new ClosedTabs((message) => said.push(message));
    closed.open(file);
    expect(closed.all()).toEqual([]);
    expect(said).toHaveLength(1);
  });
});
