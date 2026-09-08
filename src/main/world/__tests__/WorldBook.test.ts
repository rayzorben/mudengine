import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorldBook } from '../WorldBook';

let dir = '';
let file = '';
let notices: string[] = [];

const book = (): WorldBook => new WorldBook({ file, notify: (message) => notices.push(message) });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-worlds-'));
  file = path.join(dir, 'state', 'worlds.json');
  notices = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('what a realm has said it runs', () => {
  it('knows nothing about an address it has never dialled', () => {
    expect(book().at('bbs.bearfather.net:23')).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('remembers the word across launches, keyed by address', () => {
    expect(book().learn('bbs.bearfather.net:23', 'majormud', 5)).toBe('majormud');
    // A second book, as the next launch would be: the file is what remembers.
    const later = book();
    expect(later.at('bbs.bearfather.net:23')).toBe('majormud');
    expect(later.at('paramud.mudinfo.net:2323')).toBeNull();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      v: 1,
      realms: { 'bbs.bearfather.net:23': { world: 'majormud', realm: 'majormud', at: 5 } }
    });
  });

  it("files a GreaterMUD server under Paradigm's world, keeping its own word", () => {
    expect(book().learn('orohost:2427', 'greatermud', 1)).toBe('paradigm');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).realms['orohost:2427']).toEqual({
      world: 'paradigm',
      realm: 'greatermud',
      at: 1
    });
  });

  it('writes only when the answer changes', () => {
    const held = book();
    held.learn('orohost:2427', 'paradigm', 1);
    const written = fs.statSync(file).mtimeMs;
    fs.utimesSync(file, new Date(written - 60_000), new Date(written - 60_000));
    held.learn('orohost:2427', 'paradigm', 2);
    expect(fs.statSync(file).mtimeMs).toBeLessThan(written);
    held.learn('orohost:2427', 'majormud', 3);
    expect(held.at('orohost:2427')).toBe('majormud');
    expect(fs.statSync(file).mtimeMs).toBeGreaterThanOrEqual(written);
  });

  it('drops a hand-edited entry whose word and world disagree, and a stranger', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        realms: {
          'a:1': { world: 'paradigm', realm: 'majormud', at: 1 },
          'b:2': { world: 'lineage-three', realm: 'majormud', at: 1 },
          'c:3': { world: 'majormud', realm: 'majormud', at: 'yesterday' }
        }
      })
    );
    const held = book();
    expect(held.at('a:1')).toBeNull();
    expect(held.at('b:2')).toBeNull();
    expect(held.at('c:3')).toBe('majormud');
  });

  it('leaves a file that will not parse alone, and says so', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    const held = book();
    expect(held.at('a:1')).toBeNull();
    expect(held.learn('a:1', 'majormud')).toBe('majormud');
    // Kept in memory for this run; the file is not overwritten.
    expect(held.at('a:1')).toBe('majormud');
    expect(fs.readFileSync(file, 'utf8')).toBe('{not json');
    expect(notices.join(' ')).toContain('worlds.json');
  });
});
