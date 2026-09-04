import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LoopStore } from '../LoopStore';
import { ServerStore } from '../ServerStore';
import { homeAt, type Home } from '../../app/home';

let dir = '';
let home: Home;
let stores: LoopStore[] = [];

function write(where: string, name: string, body: string): void {
  fs.mkdirSync(where, { recursive: true });
  fs.writeFileSync(path.join(where, name), body, 'utf8');
}

function open(onError?: (message: string) => void): LoopStore {
  const store = new LoopStore(home, onError);
  stores.push(store);
  return store;
}

const LOOP = "name: Sewer loop\nstops:\n  - 'Sewer Tunnel 1/606'\n  - 'Sewer Tunnel 1/604'\n";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-loops-'));
  home = homeAt(dir);
  stores = [];
});

afterEach(() => {
  for (const store of stores) store.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('where a loop is decides who may walk it', () => {
  it('reads all three scopes, keyed by the directory they sit in', () => {
    write(home.globalLoops, 'sewer.yaml', LOOP);
    write(home.server('greatermud').loops, 'docks.yaml', 'name: Docks\nstops: [A, B]\n');
    write(home.profile('vaelor').loops, 'arena.yaml', 'name: Arena\nstops: [C, D]\n');

    const store = open();
    expect(store.globalLoops.map((loop) => loop.name)).toEqual(['Sewer loop']);
    expect(store.forServer('greatermud').map((loop) => loop.name)).toEqual(['Docks']);
    expect(store.forProfile('vaelor').map((loop) => loop.name)).toEqual(['Arena']);
  });

  it('has nothing to say about a scope with no directory', () => {
    expect(open().forServer('nowhere')).toEqual([]);
  });

  /*
   * A file in a loops directory was put there on purpose, so one that produces
   * nothing is a loop somebody believes they have -- reported rather than
   * skipped in silence.
   */
  it('reports a file that describes no loop', () => {
    const said: string[] = [];
    write(home.globalLoops, 'empty.yaml', '# nothing here\n');
    open((message) => said.push(message));
    expect(said.join(' ')).toContain('empty.yaml');
  });

  it('reports one that will not parse, and keeps the others', () => {
    const said: string[] = [];
    write(home.globalLoops, 'broken.yaml', 'stops: [unclosed\n');
    write(home.globalLoops, 'sewer.yaml', LOOP);
    const store = open((message) => said.push(message));
    expect(store.globalLoops.map((loop) => loop.name)).toEqual(['Sewer loop']);
    expect(said.join(' ')).toContain('broken.yaml');
  });

  /* A loop needs somewhere to go and somewhere to come back to. */
  it('drops one with a single stop', () => {
    write(home.globalLoops, 'one.yaml', 'name: Nowhere\nstops: [A]\n');
    expect(open().globalLoops).toEqual([]);
  });

  /*
   * The name is how a loop is addressed everywhere else, and a file that
   * plainly describes one should not be dropped for want of a key. The file's
   * own name is a worse name than the player would have chosen and a far
   * better one than nothing.
   */
  it('names an unnamed loop after its file', () => {
    write(home.globalLoops, 'sewer-run.yaml', 'stops: [A, B]\n');
    expect(open().globalLoops[0]?.name).toBe('sewer-run');
  });

  /* A list, or a `loops:` block pasted out of an older options file. Refusing
     those would be refusing a file whose meaning is not in doubt. */
  it('reads a file holding more than one', () => {
    write(
      home.globalLoops,
      'both.yaml',
      'loops:\n  - name: A\n    stops: [one, two]\n  - name: B\n    stops: [three, four]\n'
    );
    expect(open().globalLoops.map((loop) => loop.name)).toEqual(['A', 'B']);
  });

  it('ignores a backup and anything that is not YAML', () => {
    write(home.globalLoops, 'sewer.yaml', LOOP);
    write(home.globalLoops, 'sewer.yaml.bak', LOOP);
    write(home.globalLoops, 'notes.txt', LOOP);
    expect(open().globalLoops).toHaveLength(1);
  });

  it('notices a loop written while the client is running', async () => {
    const store = open();
    store.watch();
    const changed = new Promise<void>((resolve) => store.on('change', () => resolve()));
    write(home.globalLoops, 'sewer.yaml', LOOP);
    await changed;
    expect(store.globalLoops).toHaveLength(1);
  });
});

describe('servers, one directory each', () => {
  it('reads what is on disk and joins a name to its directory', () => {
    fs.mkdirSync(home.server('greatermud-local').dir, { recursive: true });
    fs.writeFileSync(
      home.server('greatermud-local').file,
      'name: GreaterMUD (local)\nhost: orohost\nport: 2427\n',
      'utf8'
    );
    const store = new ServerStore(home);
    expect(store.servers.map((server) => server.name)).toEqual(['GreaterMUD (local)']);
    // Case-insensitively, the way `server:` has always been looked up.
    expect(store.idFor('greatermud (LOCAL)')).toBe('greatermud-local');
    store.dispose();
  });

  /* A defaulted server is a character dialling somewhere nobody chose -- the
     rule a profile with no server follows too. */
  it('refuses one with no host, and says which file', () => {
    const said: string[] = [];
    fs.mkdirSync(home.server('broken').dir, { recursive: true });
    fs.writeFileSync(home.server('broken').file, 'name: Nowhere\n', 'utf8');
    const store = new ServerStore(home, (message) => said.push(message));
    expect(store.servers).toEqual([]);
    expect(said.join(' ')).toContain('server.yaml');
    store.dispose();
  });

  /* The directory's name is a real answer: a file put there by hand and named
     after the place is offered rather than dropped. */
  it('falls back to the directory name', () => {
    fs.mkdirSync(home.server('bearfather').dir, { recursive: true });
    fs.writeFileSync(home.server('bearfather').file, 'host: bbs.bearfather.net\n', 'utf8');
    const store = new ServerStore(home);
    expect(store.servers[0]?.name).toBe('bearfather');
    store.dispose();
  });
});
