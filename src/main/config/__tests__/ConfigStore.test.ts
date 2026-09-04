import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfigStore } from '../ConfigStore';
import { DEFAULT_CONFIG, type ConfigSnapshot } from '../../../shared/config';

let dir: string;
let stores: ConfigStore[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-config-'));
  stores = [];
});

afterEach(() => {
  for (const store of stores) store.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Constructs a store and registers it for teardown. */
function open(options: ConstructorParameters<typeof ConfigStore>[0]): ConfigStore {
  const store = new ConfigStore(options);
  stores.push(store);
  return store;
}

/**
 * Waits for the next `change`.
 *
 * The store polls (`fs.watchFile`) rather than subscribing to inotify, so a
 * reload is a poll interval plus a debounce away — the generous timeout is the
 * mechanism's cost, not flakiness.
 */
function nextChange(store: ConfigStore, timeoutMs = 5000): Promise<ConfigSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no change event')), timeoutMs);
    store.on('change', (snapshot) => {
      clearTimeout(timer);
      resolve(snapshot);
    });
  });
}

/**
 * Rewrites a file the way an atomic-save editor does: write a sibling, then
 * rename over the target. `fs.watch` loses its subscription on this, which is
 * precisely why the store polls instead.
 */
function atomicWrite(file: string, contents: string): void {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, contents, 'utf8');
  fs.renameSync(temp, file);
}

describe('ConfigStore', () => {
  it('adopts the first candidate that already exists', () => {
    const first = path.join(dir, 'first.yaml');
    const second = path.join(dir, 'second.yaml');
    fs.writeFileSync(second, 'terminal:\n  font:\n    size: 21\n');

    const store = open({ searchPaths: [first, second] });

    expect(store.path).toBe(second);
    expect(store.config.terminal.font.size).toBe(21);
  });

  it('creates the first candidate from the template when nothing exists', () => {
    const template = path.join(dir, 'default.yaml');
    fs.writeFileSync(template, '# a comment\nui:\n  density: compact\n');
    const target = path.join(dir, 'nested', 'user.yaml');

    const store = open({ searchPaths: [target], template });

    expect(fs.existsSync(target)).toBe(true);
    expect(store.path).toBe(target);
    // The comments come with it: the template is the documentation.
    expect(fs.readFileSync(target, 'utf8')).toContain('# a comment');
    expect(store.config.ui.density).toBe('compact');
  });

  it('reads a file that is only comments as "all defaults"', () => {
    const file = path.join(dir, 'user.yaml');
    fs.writeFileSync(file, '# nothing set yet\n');

    const store = open({ searchPaths: [file] });

    expect(store.config).toEqual(DEFAULT_CONFIG);
    expect(store.snapshot.error).toBeNull();
  });

  it('reloads on change without a restart', async () => {
    const file = path.join(dir, 'user.yaml');
    fs.writeFileSync(file, 'terminal:\n  font:\n    size: 14\n');

    const store = open({ searchPaths: [file] });
    expect(store.config.terminal.font.size).toBe(14);

    store.watch();
    const changed = nextChange(store);
    fs.writeFileSync(file, 'terminal:\n  font:\n    size: 20\n');

    const snapshot = await changed;
    expect(snapshot.error).toBeNull();
    expect(snapshot.config.terminal.font.size).toBe(20);
    expect(store.config.terminal.font.size).toBe(20);
  });

  it('survives an editor that saves by rename', async () => {
    const file = path.join(dir, 'user.yaml');
    fs.writeFileSync(file, 'ui:\n  density: comfortable\n');

    const store = open({ searchPaths: [file] });
    store.watch();

    const changed = nextChange(store);
    atomicWrite(file, 'ui:\n  density: compact\n');

    expect((await changed).config.ui.density).toBe('compact');
  });

  it('keeps the last good values when a save leaves the file unparseable', async () => {
    const file = path.join(dir, 'user.yaml');
    fs.writeFileSync(file, 'connection:\n  port: 2427\n');

    const store = open({ searchPaths: [file] });
    store.watch();

    const changed = nextChange(store);
    // A half-typed list: valid to write, not valid YAML.
    fs.writeFileSync(file, 'connection:\n  port: 2427\n  encoding: [cp437\n');

    const snapshot = await changed;
    expect(snapshot.error).toBeTruthy();
    expect(snapshot.config.connection.port).toBe(2427);
  });

  it('recovers on the next good save after a parse error', async () => {
    const file = path.join(dir, 'user.yaml');
    fs.writeFileSync(file, 'connection:\n  port: 2427\n');

    const store = open({ searchPaths: [file] });
    store.watch();

    const broken = nextChange(store);
    fs.writeFileSync(file, 'connection: [\n');
    expect((await broken).error).toBeTruthy();

    store.removeAllListeners('change');
    const fixed = nextChange(store);
    fs.writeFileSync(file, 'connection:\n  port: 4000\n');

    const snapshot = await fixed;
    expect(snapshot.error).toBeNull();
    expect(snapshot.config.connection.port).toBe(4000);
  });

  it('falls back to defaults when no candidate is writable', () => {
    // An empty search path list leaves nowhere to create the file.
    const store = open({ searchPaths: [] });
    expect(store.config).toEqual(DEFAULT_CONFIG);
  });

  it('stops polling once disposed', () => {
    const file = path.join(dir, 'user.yaml');
    fs.writeFileSync(file, 'connection:\n  port: 2427\n');

    const store = open({ searchPaths: [file] });
    store.watch();
    store.dispose();

    // Disposing twice must not throw — main calls it from two lifecycle hooks.
    expect(() => store.dispose()).not.toThrow();
  });
});

/*
 * An explicit choice is not a candidate.
 *
 * `MUDENGINE_CONFIG` used to be the first *search path*, and a search path only
 * wins if the file it names already exists — so pointing it at a fresh location
 * fell through to whichever ordinary location happened to have a file. On a
 * developer's machine that is their real configuration, with their real
 * characters in it, and nothing said so.
 */
describe('being told which options file to use', () => {
  it('uses it even though it does not exist yet, and creates it', () => {
    const wanted = path.join(dir, 'fresh', 'config.yaml');
    const ordinary = path.join(dir, 'ordinary.yaml');
    fs.writeFileSync(ordinary, 'connection:\n  port: 9999\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'template.yaml'), 'connection:\n  port: 2427\n', 'utf8');

    const store = new ConfigStore({
      override: wanted,
      searchPaths: [ordinary],
      template: path.join(dir, 'template.yaml')
    });
    try {
      expect(store.path).toBe(wanted);
      expect(fs.existsSync(wanted)).toBe(true);
      // From the template, not from the file it did not choose.
      expect(store.config.connection.port).toBe(2427);
    } finally {
      store.dispose();
    }
  });

  it('uses it when it does exist, over anything else', () => {
    const wanted = path.join(dir, 'wanted.yaml');
    const ordinary = path.join(dir, 'ordinary.yaml');
    fs.writeFileSync(wanted, 'connection:\n  port: 1234\n', 'utf8');
    fs.writeFileSync(ordinary, 'connection:\n  port: 9999\n', 'utf8');

    const store = new ConfigStore({ override: wanted, searchPaths: [ordinary] });
    try {
      expect(store.path).toBe(wanted);
      expect(store.config.connection.port).toBe(1234);
    } finally {
      store.dispose();
    }
  });

  it('falls back to the ordinary search when nobody asked for one', () => {
    const ordinary = path.join(dir, 'ordinary.yaml');
    fs.writeFileSync(ordinary, 'connection:\n  port: 9999\n', 'utf8');

    const store = new ConfigStore({ override: '', searchPaths: [ordinary] });
    try {
      expect(store.path).toBe(ordinary);
    } finally {
      store.dispose();
    }
  });
});
