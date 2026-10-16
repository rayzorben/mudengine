import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { UNCATEGORISED } from '../../../shared/loops';
import { homeAt, type Home } from '../../app/home';
import { setTuning } from '../../app/tuning';
import { routeFiles } from '../HeldFiles';
import type { Poller } from '../Poller';
import { ProfileStore } from '../ProfileStore';
import { SettingsEditor } from '../SettingsEditor';
import { ConfigStore } from '../ConfigStore';
import { LoopStore } from '../LoopStore';
import { ServerStore } from '../ServerStore';

/*
 * A change the client makes is live before its file is written, and its own
 * write is never read back as somebody else's edit (todo 137). The poll is an
 * hour away throughout, so nothing here can be the poll, and the directory
 * watch is left out (`Poller.test.ts` holds it), so a check runs only when a
 * test asks for one.
 */
/** Every directory listing anything here makes, counted. */
const listings = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  const readdirSync = ((...args: Parameters<typeof real.readdirSync>) => {
    listings.count += 1;
    return real.readdirSync(...args);
  }) as typeof real.readdirSync;
  return { ...real, readdirSync, default: { ...real, readdirSync } };
});
vi.mock('../revision', async (original) => ({
  ...(await original<typeof import('../revision')>()),
  directoriesOf: async () => new Map()
}));
let root: string;
let home: Home;
let file: string;
let store: ProfileStore;

const BODY = '# Thorn, played on the local realm.\nserver: local\nname: Thorn\n';

beforeEach(() => {
  setTuning({
    ...DEFAULT_INTERNAL.tuning,
    files: { ...DEFAULT_INTERNAL.tuning.files, pollIntervalMs: 3_600_000 }
  });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-held-'));
  home = homeAt(root);
  file = home.profile('thorn').file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, BODY);
  store = new ProfileStore({
    directory: home.profilesDir,
    base: () => ({ servers: [{ name: 'local', host: 'orohost', port: 2427 }] })
  });
});

afterEach(() => {
  vi.useRealTimers();
  store.dispose();
  setTuning(DEFAULT_INTERNAL.tuning);
  fs.rmSync(root, { recursive: true, force: true });
});

const combat = (): boolean | undefined => store.profiles[0]?.config.automation.combat.enabled;

function editor(): SettingsEditor {
  return new SettingsEditor({
    home,
    stores: {
      files: routeFiles([store.files]),
      servers: () => new ServerStore(home),
      loops: () => new LoopStore(home)
    }
  });
}

/** Past the reload's debounce, and short of the hour-long poll. */
const settleDebounce = (): void => {
  vi.advanceTimersByTime(DEFAULT_INTERNAL.tuning.files.debounceMs);
};

/** The store's own watch, asked directly so a test decides when it checks. */
const pollerOf = (owner: ProfileStore): Poller => (owner as unknown as { poller: Poller }).poller;

describe('a store edit', () => {
  it('has a toolbar press live in the same turn, before the file is written', () => {
    const before = combat();
    const onDisk: string[] = [];
    store.on('change', () => onDisk.push(fs.readFileSync(file, 'utf8')));

    expect(editor().setAutomationSwitch('thorn', 'combat', !before).ok).toBe(true);

    expect(combat()).toBe(!before);
    // The change was emitted while the file still held the old text.
    expect(onDisk).toEqual([BODY]);
    const written = fs.readFileSync(file, 'utf8');
    expect(written).toContain('# Thorn, played on the local realm.');
    expect(written).toContain(`enabled: ${String(!before)}`);
  });

  it('lists no directory for a toolbar press, where reading the store does', () => {
    listings.count = 0;
    expect(editor().setAutomationSwitch('thorn', 'combat', !combat()).ok).toBe(true);
    expect(listings.count).toBe(0);
    // The positive control: the same counter sees the store's own read.
    store.reload();
    expect(listings.count).toBeGreaterThan(0);
  });

  it('is not reloaded as an edit from elsewhere, while a hand edit is', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    store.watch();
    let changes = 0;
    store.on('change', () => (changes += 1));

    editor().setAutomationSwitch('thorn', 'combat', !combat());
    expect(changes).toBe(1);
    await pollerOf(store).poll();
    settleDebounce();
    expect(changes).toBe(1);

    // The positive control: the same check does reload an edit made by hand.
    fs.writeFileSync(file, BODY.replace('Thorn\n', 'Thorn the Unready\n'));
    await pollerOf(store).poll();
    settleDebounce();
    expect(changes).toBe(2);
    expect(store.profiles[0]?.name).toBe('Thorn the Unready');
  });

  it('leaves a hand edit made before it to be reloaded', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    store.watch();
    fs.mkdirSync(home.profile('mara').dir, { recursive: true });
    fs.writeFileSync(home.profile('mara').file, 'server: local\nname: Mara\n');

    editor().setAutomationSwitch('thorn', 'combat', !combat());
    expect(store.profiles.map((profile) => profile.id)).toEqual(['thorn']);
    await pollerOf(store).poll();
    settleDebounce();
    expect(store.profiles.map((profile) => profile.id)).toEqual(['mara', 'thorn']);
  });

  it('puts the value back and says why when the write fails', () => {
    const before = combat();
    // A directory where the backup goes: the write fails for root too.
    fs.mkdirSync(`${file}.bak`);
    let changes = 0;
    store.on('change', () => (changes += 1));

    const result = editor().setAutomationSwitch('thorn', 'combat', !before);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain(path.basename(file));
    expect(combat()).toBe(before);
    expect(changes).toBe(2);
    expect(fs.readFileSync(file, 'utf8')).toBe(BODY);
  });

  it('refuses a file it could not read rather than writing over it', () => {
    // A file that cannot be read for root either: a directory where the file goes.
    const mara = home.profile('mara').file;
    fs.mkdirSync(mara, { recursive: true });
    store.reload();
    let changes = 0;
    store.on('change', () => (changes += 1));

    const result = editor().setAutomationSwitch('mara', 'combat', true);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain(path.basename(mara));
    expect(changes).toBe(0);
    expect(fs.statSync(mara).isDirectory()).toBe(true);
  });

  it('edits a file made by hand since the last check from what it says', () => {
    const mara = home.profile('mara').file;
    fs.mkdirSync(path.dirname(mara), { recursive: true });
    fs.writeFileSync(mara, '# Mara, by hand.\nserver: local\nname: Mara\n');

    expect(editor().setAutomationSwitch('mara', 'combat', true).ok).toBe(true);

    expect(fs.readFileSync(mara, 'utf8')).toContain('# Mara, by hand.');
    expect(store.profiles.find((profile) => profile.id === 'mara')?.name).toBe('Mara');
  });

  it('writes a file no store holds straight to disk', () => {
    const loops = home.globalLoops;
    const result = editor().addLoop('global', null, {
      name: 'Sewer loop',
      stops: [{ room: 'Sewer Tunnel 1/606' }, { room: 'Sewer Tunnel 1/604' }],
      category: UNCATEGORISED
    });
    expect(result.ok).toBe(true);
    expect(fs.readdirSync(loops)).toContain('sewer-loop.yaml');
  });

  it('has a global save and a filed loop live in the same turn, through their stores', () => {
    fs.mkdirSync(path.dirname(home.options), { recursive: true });
    fs.writeFileSync(home.options, '# My options.\nconnection:\n  host: orohost\n');
    const options = new ConfigStore({ override: home.options, searchPaths: [home.options] });
    const loops = new LoopStore(home);
    const live = new SettingsEditor({
      home,
      stores: {
        files: routeFiles([options.files, store.files, loops.files]),
        servers: () => new ServerStore(home),
        loops: () => loops
      }
    });
    try {
      const draft = live.globalDraft();
      const saved = live.saveGlobal({
        ...draft,
        connection: { ...draft.connection, host: 'elsewhere' }
      });
      expect(saved).toEqual({ ok: true });
      expect(options.config.connection.host).toBe('elsewhere');
      expect(fs.readFileSync(home.options, 'utf8')).toContain('# My options.');

      const sewers = {
        name: 'Sewer loop',
        stops: [{ room: 'Sewer Tunnel 1/606' }, { room: 'Sewer Tunnel 1/604' }],
        category: UNCATEGORISED
      };
      expect(live.addLoop('profile', 'thorn', sewers)).toEqual({ ok: true });
      expect(loops.forProfile('thorn').map((loop) => loop.name)).toEqual(['Sewer loop']);
    } finally {
      options.dispose();
      loops.dispose();
    }
  });
});
