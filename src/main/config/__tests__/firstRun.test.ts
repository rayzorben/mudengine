import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfigStore } from '../ConfigStore';
import { InternalStore } from '../InternalStore';
import { seedServers } from '../shippedRealms';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-first-run-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A crash part way through a write: the first half of the text reaches
 * whatever path was being written, then the process stops.
 */
function crashMidWrite(): void {
  const real = fs.writeFileSync;
  vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((file, data) => {
    real(file, String(data).slice(0, 10));
    throw new Error('crashed mid-write');
  });
}

function template(name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '# the annotated template\nterminal:\n  quiet: {}\n', 'utf8');
  return file;
}

describe('first-run copies', () => {
  it('leaves no half internal.yaml behind a crash', () => {
    const file = path.join(dir, 'home', 'internal.yaml');
    const from = template('internal.template.yaml');
    crashMidWrite();
    new InternalStore({ file, template: from }).dispose();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('leaves no half options file behind a crash', () => {
    const file = path.join(dir, 'home', 'global', 'default.yaml');
    const from = template('default.template.yaml');
    crashMidWrite();
    new ConfigStore({ searchPaths: [file], template: from }).dispose();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('leaves no half options file at an override behind a crash', () => {
    const file = path.join(dir, 'home', 'chosen.yaml');
    const from = template('default.template.yaml');
    crashMidWrite();
    new ConfigStore({ override: file, searchPaths: [], template: from }).dispose();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('seedServers', () => {
  let shipped: string;
  let servers: string;

  beforeEach(() => {
    shipped = path.join(dir, 'resources', 'servers');
    servers = path.join(dir, 'home', 'servers');
    for (const id of ['one', 'two', 'three']) {
      fs.mkdirSync(path.join(shipped, id), { recursive: true });
      fs.writeFileSync(path.join(shipped, id, 'server.yaml'), `name: ${id}\n`, 'utf8');
    }
  });

  const read = (id: string): string | null => {
    const file = path.join(servers, id, 'server.yaml');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  };

  it('copies every shipped realm on first run', () => {
    seedServers({ shipped, serversDir: servers });
    expect([read('one'), read('two'), read('three')]).toEqual([
      'name: one\n',
      'name: two\n',
      'name: three\n'
    ]);
  });

  it('leaves no half realm file behind a crash, and the next run finishes it', () => {
    crashMidWrite();
    expect(() => seedServers({ shipped, serversDir: servers })).not.toThrow();
    expect(read('one')).toBeNull();

    seedServers({ shipped, serversDir: servers });
    expect([read('one'), read('two'), read('three')]).toEqual([
      'name: one\n',
      'name: two\n',
      'name: three\n'
    ]);
  });

  it('refills a half-filled folder without touching a file already there', () => {
    fs.mkdirSync(path.join(servers, 'one'), { recursive: true });
    fs.writeFileSync(path.join(servers, 'one', 'server.yaml'), 'name: edited\n', 'utf8');

    const result = seedServers({ shipped, serversDir: servers });

    expect(result.written).toEqual(['three', 'two']);
    expect([read('one'), read('two'), read('three')]).toEqual([
      'name: edited\n',
      'name: two\n',
      'name: three\n'
    ]);
  });

  it('does not bring back a realm deleted from the Realms page', () => {
    fs.mkdirSync(path.join(servers, 'two'), { recursive: true });
    fs.writeFileSync(path.join(servers, 'two', 'server.yaml.bak'), 'name: two\n', 'utf8');

    seedServers({ shipped, serversDir: servers });

    expect(read('two')).toBeNull();
    expect(read('one')).toBe('name: one\n');
  });

  it('copies none of a deleted realm’s other files back into what it left', () => {
    fs.mkdirSync(path.join(shipped, 'two', 'loops'));
    fs.writeFileSync(path.join(shipped, 'two', 'loops', 'lap.yaml'), 'name: lap\n', 'utf8');
    fs.mkdirSync(path.join(servers, 'two'), { recursive: true });
    fs.writeFileSync(path.join(servers, 'two', 'server.yaml.bak'), 'name: two\n', 'utf8');

    const result = seedServers({ shipped, serversDir: servers });

    expect(result.written).toEqual(['one', 'three']);
    expect(fs.existsSync(path.join(servers, 'two', 'loops', 'lap.yaml'))).toBe(false);
  });

  it('does nothing once a run has finished the copy', () => {
    seedServers({ shipped, serversDir: servers });
    fs.rmSync(path.join(servers, 'two'), { recursive: true });

    const again = seedServers({ shipped, serversDir: servers });

    expect(again.written).toEqual([]);
    expect(read('two')).toBeNull();
  });

  it('copies a realm a later release ships into a home that finished the copy', () => {
    seedServers({ shipped, serversDir: servers });
    fs.rmSync(path.join(servers, 'two'), { recursive: true });
    fs.mkdirSync(path.join(shipped, 'four'));
    fs.writeFileSync(path.join(shipped, 'four', 'server.yaml'), 'name: four\n', 'utf8');

    const again = seedServers({ shipped, serversDir: servers });

    expect(again.written).toEqual(['four']);
    expect(read('two')).toBeNull();
    expect(fs.readFileSync(path.join(servers, '.shipped'), 'utf8')).toContain('four');
  });

  it('reads a list naming no realm as the six Paradigm realms shipped before it named them', () => {
    fs.mkdirSync(path.join(shipped, 'paradigm-game-3'));
    fs.writeFileSync(path.join(shipped, 'paradigm-game-3', 'server.yaml'), 'name: p3\n', 'utf8');
    fs.mkdirSync(servers, { recursive: true });
    fs.writeFileSync(
      path.join(servers, '.shipped'),
      '# Every shipped realm has been copied in once.\n'
    );

    const result = seedServers({ shipped, serversDir: servers });

    expect(result.written).toEqual(['one', 'three', 'two']);
    expect(read('paradigm-game-3')).toBeNull();
  });

  it('copies no shipped realm whose name another realm here has', () => {
    fs.mkdirSync(path.join(servers, 'mine'), { recursive: true });
    fs.writeFileSync(path.join(servers, 'mine', 'server.yaml'), 'name: TWO\nhost: h\n', 'utf8');

    const result = seedServers({ shipped, serversDir: servers });

    expect(result.written).toEqual(['one', 'three']);
    expect(read('two')).toBeNull();
  });

  it('copies nothing when the client ships no realms', () => {
    const result = seedServers({ shipped: path.join(dir, 'none'), serversDir: servers });
    expect(result.written).toEqual([]);
    expect(fs.existsSync(servers)).toBe(false);
  });
});
