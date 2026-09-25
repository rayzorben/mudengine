import { describe, expect, it, vi } from 'vitest';

import { NO_CARD_SETTINGS } from '../cards';
import { t } from '../i18n';
import { paletteCommands, paletteKeys, type PaletteDeps } from '../palette';
import { chord } from '../platform';
import { THEMES } from '@shared/themes';
import type { Revealed, SessionId } from '@shared/ipc';

const HERO = 'hero' as SessionId;
const HEALER = 'healer' as SessionId;
const OPENED: Revealed = { how: 'opened' };

/** A window showing one character in the realm, standing still, nothing dragged. */
function deps(over: Partial<PaletteDeps> = {}): PaletteDeps {
  return {
    api: {
      host: 'electron',
      loadProfile: vi.fn(async () => undefined),
      popOut: vi.fn(async () => null),
      popIn: vi.fn(async () => null),
      gatherWindows: vi.fn(async () => null),
      startLoop: vi.fn(async () => null),
      stopMoving: vi.fn(async () => undefined),
      revealConfig: vi.fn(async () => OPENED),
      revealProfiles: vi.fn(async () => OPENED),
      revealLogs: vi.fn(async () => OPENED)
    },
    session: HERO,
    sessions: [{ id: HERO, name: 'Hero' }],
    profiles: [],
    servers: [],
    phases: {},
    showTabs: true,
    connected: false,
    inGame: true,
    moving: false,
    loops: [],
    configPath: '/home/someone/.config/mudengine/options.yaml',
    loggingEnabled: true,
    railOpen: false,
    debugOpen: false,
    hud: 'on',
    setHud: vi.fn(),
    density: 'comfortable',
    densityPreference: 'auto',
    cycleDensity: vi.fn(),
    theme: {
      theme: THEMES.dark,
      preference: 'dark',
      consolePreference: 'theme',
      cycle: vi.fn(),
      choose: vi.fn(),
      chooseConsole: vi.fn()
    },
    tabSide: 'left',
    setTabSide: vi.fn(),
    panes: [HERO],
    paneFlow: 'rows',
    addPane: vi.fn(),
    closePane: vi.fn(),
    turnPanes: vi.fn(),
    cards: {
      show: vi.fn(),
      away: [],
      isShown: () => false,
      settingsOf: () => NO_CARD_SETTINGS,
      setSettings: vi.fn(),
      floats: [],
      rolled: [],
      reset: vi.fn()
    },
    widths: { rail: null, tabs: null, above: null, below: null, reset: vi.fn() },
    openSettings: vi.fn(),
    manageServers: vi.fn(),
    editGlobal: vi.fn(),
    editDefaults: vi.fn(),
    toggleConnection: vi.fn(),
    connect: vi.fn(),
    showSession: vi.fn(),
    closeSession: vi.fn(),
    openRoute: vi.fn(),
    openBuilder: vi.fn(),
    openSearch: vi.fn(),
    toggleRail: vi.fn(),
    toggleDebug: vi.fn(),
    toggleLoops: vi.fn(),
    reveal: vi.fn(),
    terminal: () => null,
    say: vi.fn(),
    ...over
  };
}

const ids = (over?: Partial<PaletteDeps>): string[] => paletteCommands(deps(over)).map((c) => c.id);
const find = (id: string, over?: Partial<PaletteDeps>) => {
  const command = paletteCommands(deps(over)).find((c) => c.id === id);
  if (command === undefined) throw new Error(`no command ${id}`);
  return command;
};

describe('the palette commands', () => {
  it('offers a stop only while the character is moving', () => {
    expect(ids()).not.toContain('move:stop');
    expect(ids({ moving: true })).toContain('move:stop');
  });

  it('offers a switch only when there is another character to switch to', () => {
    expect(ids().some((id) => id.startsWith('show:'))).toBe(false);
    const two = {
      sessions: [
        { id: HERO, name: 'Hero' },
        { id: HEALER, name: 'Healer' }
      ]
    };
    expect(ids(two)).toContain(`show:${HEALER}`);
    expect(ids(two)).not.toContain(`show:${HERO}`);
  });

  it('withholds the window moves in a browser tab, where there is no second window', () => {
    expect(ids()).toContain('popout');
    const web = { api: { ...deps().api, host: 'web' } as PaletteDeps['api'] };
    expect(ids(web)).not.toContain('popout');
    expect(ids(web)).not.toContain('gather');
  });

  it('hints each command with its chord', () => {
    expect(find('settings').hint).toBe(chord(','));
    expect(find('search').hint).toBe(chord('F'));
    expect(find('rail').hint).toBe(chord('D', true));
  });

  it('labels a toggle with what pressing it does', () => {
    expect(find('rail').label).toBe(t('palette.view.showDiagnosticsLabel'));
    expect(find('rail', { railOpen: true }).label).toBe(t('palette.view.hideDiagnosticsLabel'));
  });

  it('runs the callback it was handed, and the surfaces that take the caret say so', () => {
    const openSettings = vi.fn();
    const command = find('settings', { openSettings });
    command.run();
    expect(openSettings).toHaveBeenCalledOnce();
    expect(command.movesFocus).toBe(true);
    expect(find('rail').movesFocus).toBeUndefined();
  });

  it('turns the cards off when they are on', () => {
    const setHud = vi.fn();
    find('hud', { setHud }).run();
    expect(setHud).toHaveBeenCalledWith('off');
  });

  it("starts a loop on the shown character and says a refusal in that character's console", async () => {
    const say = vi.fn();
    const startLoop = vi.fn(async () => 'nothing to loop');
    const api = { ...deps().api, startLoop } as PaletteDeps['api'];
    find('loop:north', { api, say, loops: [{ name: 'north', stops: 4 }] }).run();
    expect(startLoop).toHaveBeenCalledWith(HERO, 'north');
    await vi.waitFor(() => expect(say).toHaveBeenCalledWith(HERO, 'nothing to loop'));
  });

  it('shortens the options path to its two ends', () => {
    expect(find('config').hint).toBe('~/.config/mudengine/options.yaml');
    const deep = '/home/someone/a/very/deep/tree/of/folders/that/goes/on/mudengine/options.yaml';
    expect(find('config', { configPath: deep }).hint).toBe('~/a/…/mudengine/options.yaml');
  });
});

/*
 * What `App` memoises the list on (todo 754): five fields were once missing
 * from a hand-kept list, so the keys are every field by construction. A new
 * value in any field moves them; a fresh group with the same members does not,
 * because `App` builds `theme` and `widths` fresh every render.
 */
describe('what the list is rebuilt on', () => {
  const moved = (a: readonly unknown[], b: readonly unknown[]): boolean =>
    a.length !== b.length || a.some((value, at) => !Object.is(value, b[at]));

  it('moves with every field it is handed, grouped members included', () => {
    const base = deps();
    const keys = paletteKeys(base);
    for (const field of Object.keys(base) as (keyof PaletteDeps)[]) {
      const group = base[field];
      if (field === 'theme' || field === 'widths') {
        for (const member of Object.keys(group as object)) {
          const changed = { ...base, [field]: { ...(group as object), [member]: Symbol(member) } };
          expect(moved(keys, paletteKeys(changed as PaletteDeps)), `${field}.${member}`).toBe(true);
        }
      } else {
        const changed = { ...base, [field]: Symbol(field) };
        expect(moved(keys, paletteKeys(changed as unknown as PaletteDeps)), field).toBe(true);
      }
    }
  });

  it('holds still for a fresh group with the same members', () => {
    const base = deps();
    const again = { ...base, theme: { ...base.theme }, widths: { ...base.widths } };
    expect(moved(paletteKeys(base), paletteKeys(again))).toBe(false);
  });
});
