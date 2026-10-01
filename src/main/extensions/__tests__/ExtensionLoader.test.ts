import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadExtensions, pageFile } from '../ExtensionLoader';

let root: string;

function folder(name: string, files: Record<string, string>): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
}

const manifest = (name: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name, title: `The ${name}`, main: 'main.mjs', ui: 'ui', ...extra });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'extensions-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the extensions installed', () => {
  it('loads each folder whose manifest names it and whose module exports a session', async () => {
    folder('planner', {
      'manifest.json': manifest('planner'),
      'main.mjs': 'export function session() { return { view: () => 1 }; }',
      'ui/index.html': '<p>card</p>'
    });
    folder('notes', { 'readme.txt': 'not an extension' });
    const { loaded, problems } = await loadExtensions(root);
    expect(loaded.map((each) => each.manifest.title)).toEqual(['The planner']);
    expect(problems).toEqual([]);
  });

  it('says why a folder claiming to be one is not, and carries on', async () => {
    folder('broken', { 'manifest.json': '{' });
    folder('misnamed', { 'manifest.json': manifest('other') });
    folder('escaping', { 'manifest.json': manifest('escaping', { main: '../x.mjs' }) });
    folder('silent', { 'manifest.json': manifest('silent'), 'main.mjs': 'export const x = 1;' });
    const { loaded, problems } = await loadExtensions(root);
    expect(loaded).toEqual([]);
    expect(problems).toHaveLength(4);
  });

  it('is none where the folder does not exist', async () => {
    expect(await loadExtensions(path.join(root, 'absent'))).toEqual({ loaded: [], problems: [] });
  });
});

describe('a card page’s files', () => {
  it('are served from the page folder only', async () => {
    folder('planner', {
      'manifest.json': manifest('planner'),
      'main.mjs': 'export default { session: () => ({ view: () => null }) };',
      'ui/index.html': '<p>card</p>',
      'ui/assets/app.js': '1',
      'secret.txt': 'no'
    });
    const { loaded } = await loadExtensions(root);
    expect(pageFile(loaded, 'planner', '')).toMatch(/index\.html$/);
    expect(pageFile(loaded, 'planner', 'assets/app.js')).toMatch(/app\.js$/);
    expect(pageFile(loaded, 'planner', '../secret.txt')).toBeNull();
    expect(pageFile(loaded, 'planner', 'assets')).toBeNull();
    expect(pageFile(loaded, 'other', '')).toBeNull();
  });
});
