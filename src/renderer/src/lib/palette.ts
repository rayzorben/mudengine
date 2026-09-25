/**
 * The command palette's list: every command, each a label, a hint (often the
 * chord) and what it runs, as a pure function of what the commands read.
 *
 * Out of `App` (todo 732), which keeps it in one `useMemo` whose dependency
 * list is the rule for when the list is rebuilt: keyed by value, never on
 * `views` (`mudengine-ui` › *The window redraws what changed*). Every `t()`
 * here is a literal call, which is what `i18n-coverage.test.ts` reads.
 */
import type { Command } from '../components/CommandPalette';
import type { RailSide } from '../components/TabRail';
import type { TerminalHandle } from '../components/TerminalView';
import {
  cardLabel,
  hidesWhenEmpty,
  HIDES_WHEN_EMPTY,
  type CardId,
  type CardLayoutApi
} from './cards';
import { t } from './i18n';
import type { HeldLoop } from './loops';
import { chord } from './platform';
import { CONSOLE_COLUMNS as MIN_COLUMNS, type PaneFlow } from './splitter';
import type { UseTheme } from './theme';
import { tuning } from './tuning';
import {
  targetFromServer,
  type Density,
  type DensityPreference,
  type Server
} from '@shared/config';
import type { IpcApi, ProfileSummary, Revealed, SessionId, SessionSummary } from '@shared/ipc';
import { CONSOLE_PALETTES, TERMINAL_THEMES, THEME_PREFERENCES, THEMES } from '@shared/themes';
import type { ConnectionState, ConnectionTarget } from '@shared/types';

/** The bridge calls a command makes, and nothing else of it. */
export type PaletteApi = Pick<
  IpcApi,
  | 'host'
  | 'loadProfile'
  | 'popOut'
  | 'popIn'
  | 'gatherWindows'
  | 'startLoop'
  | 'stopMoving'
  | 'revealConfig'
  | 'revealProfiles'
  | 'revealLogs'
>;

/** What a command does to the console on screen. */
export type PaletteTerminal = Pick<TerminalHandle, 'notice' | 'jumpToLatest' | 'focus'>;

/** Everything the list is built from. `App` gathers it inside the memo. */
export interface PaletteDeps {
  api: PaletteApi;
  /** The character on screen, or `NO_SESSION`. */
  session: SessionId;
  sessions: readonly Pick<SessionSummary, 'id' | 'name'>[];
  profiles: readonly Pick<ProfileSummary, 'id' | 'name' | 'loaded' | 'target'>[];
  servers: readonly Server[];
  /** Each character's connection phase, keyed by value (`phasesKey`). */
  phases: Partial<Record<SessionId, ConnectionState['phase']>>;
  showTabs: boolean;
  connected: boolean;
  inGame: boolean;
  /** Whether the shown character is routing or looping (`movementOf`). */
  moving: boolean;
  loops: readonly HeldLoop[];
  configPath: string;
  loggingEnabled: boolean;
  railOpen: boolean;
  debugOpen: boolean;
  hud: 'on' | 'off';
  setHud(value: 'on' | 'off'): void;
  density: Density;
  densityPreference: DensityPreference;
  cycleDensity(): void;
  theme: Pick<
    UseTheme,
    'theme' | 'preference' | 'consolePreference' | 'cycle' | 'choose' | 'chooseConsole'
  >;
  tabSide: RailSide;
  setTabSide(side: RailSide): void;
  panes: readonly SessionId[];
  paneFlow: PaneFlow;
  addPane(id: SessionId): void;
  closePane(): void;
  turnPanes(next: PaneFlow): void;
  cards: Pick<
    CardLayoutApi,
    'show' | 'away' | 'isShown' | 'settingsOf' | 'setSettings' | 'floats' | 'rolled' | 'reset'
  >;
  widths: {
    rail: number | null;
    tabs: number | null;
    above: number | null;
    below: number | null;
    reset(): void;
  };
  openSettings(): void;
  manageServers(): void;
  editGlobal(): void;
  editDefaults(): void;
  toggleConnection(): void;
  connect(target: ConnectionTarget): void;
  showSession(id: SessionId): void;
  closeSession(id: SessionId): void;
  openRoute(): void;
  openBuilder(): void;
  openSearch(): void;
  toggleRail(): void;
  toggleDebug(): void;
  toggleLoops(): void;
  reveal(ask: () => Promise<Revealed>): void;
  /** The console on screen, read when a command runs. */
  terminal(): PaletteTerminal | null;
  /** A sentence into one character's console: a refusal, said where it applies. */
  say(session: SessionId, message: string): void;
}

/**
 * What the list is rebuilt on: every field it is handed, and the fields of the
 * two groups `App` builds fresh each render (`theme`, `widths`) in place of
 * the groups, which would rebuild it every render. By construction, so a value
 * the list reads cannot be left out of its memo (todo 754: five were). Every
 * field is therefore a value or a stable callback, and the shape never varies.
 */
export function paletteKeys(deps: PaletteDeps): readonly unknown[] {
  const { theme, widths, ...rest } = deps;
  return [...Object.values(rest), ...Object.values(theme), ...Object.values(widths)];
}

/**
 * A filesystem path shortened for a hint: the home directory as `~`, and the
 * middle elided once the whole thing outgrows a palette row. The two ends are
 * what identify a path — where it lives and what it is called.
 */
function shortPath(full: string, limit = 44): string {
  const home = /^\/home\/[^/]+|^\/Users\/[^/]+/.exec(full)?.[0];
  const tilde = home ? `~${full.slice(home.length)}` : full;
  if (tilde.length <= limit) return tilde;
  const parts = tilde.split('/');
  const tail = parts.slice(-2).join('/');
  const head = parts.slice(0, 2).join('/');
  return `${head}/…/${tail}`;
}

export function paletteCommands(deps: PaletteDeps): Command[] {
  const {
    api,
    session,
    sessions,
    profiles,
    phases,
    showTabs,
    connected,
    cards,
    widths,
    panes,
    paneFlow,
    tabSide,
    theme: themes
  } = deps;
  const shownName = sessions.find((e) => e.id === session)?.name ?? session;
  return [
    /*
     * Grouped, not just ordered. Twenty-odd flat commands read as one wall
     * of text, and the settings screen was buried in exactly that wall until
     * it earned a name people actually search for — grouping is the other
     * half of being found: once typing has narrowed the list, which cluster
     * a survivor came from is the fastest way to tell "this is the one" from
     * "keep reading". `Command.group` decides the border CommandPalette
     * draws; declaring same-group commands adjacent here is what keeps that
     * border one unbroken box instead of several, because a filtered list
     * only ever removes entries, never reorders them.
     */

    /*
     * Character: everything about a specific character or the roster of
     * them. First, and named for what somebody is looking for.
     *
     * Settings was twenty-sixth and called "Characters and servers…", below
     * every card, pane and window command — so the one screen you go to in
     * order to *add a character* was both out of sight and unsearchable,
     * because the palette matched on labels and no label contained the word
     * `settings`, `config` or `add`. That is the whole reason it could not
     * be found.
     */
    {
      id: 'settings',
      icon: 'settings' as const,
      label: t('palette.character.settingsLabel'),
      hint: chord(','),
      group: 'character',
      keywords: [
        'settings',
        'setting',
        'configuration',
        'config',
        'preferences',
        'options',
        'account',
        'character',
        'profile',
        'server',
        'bbs',
        'realm',
        'login',
        'password',
        'credentials',
        'add',
        'new',
        'create',
        'edit',
        'delete',
        'remove'
      ],
      // Takes the caret itself: it is a form, and the focus policy says a
      // surface that takes typed input takes focus and hands it back on exit.
      movesFocus: true,
      run: deps.openSettings
    },
    /*
     * A realm -- the server a character plays on -- is not a character's own
     * setting: it has a directory of its own because more than one character
     * plays on the same one, so it earns its own entry rather than living
     * only inside a character's form. Same reasoning as `settings` above,
     * and the same fix: named by what somebody actually types, not by what
     * the client calls it.
     */
    {
      id: 'servers',
      icon: 'server' as const,
      label: t('palette.character.serversLabel'),
      group: 'character',
      keywords: [
        'realm',
        'realms',
        'bbs',
        'server',
        'servers',
        'host',
        'port',
        'telnet',
        'mud',
        'add',
        'new',
        'edit'
      ],
      movesFocus: true,
      run: deps.manageServers
    },
    /*
     * The client's own settings — the file every character inherits from.
     *
     * Its own entry beside the other two, and named by what somebody types
     * rather than by what the client calls it: `font`, `theme`, `logging`
     * and `encoding` are all in here and none of them is a character or a
     * server, so neither of the entries above would ever have found them.
     */
    {
      id: 'settings-client',
      icon: 'settings' as const,
      label: t('palette.character.settingsClientLabel'),
      group: 'character',
      keywords: [
        'mudengine',
        'client',
        'options',
        'preferences',
        'font',
        'theme',
        'density',
        'terminal',
        'console',
        'scrollback',
        'logging',
        'capture',
        'records',
        'appearance',
        'advanced'
      ],
      movesFocus: true,
      run: deps.editGlobal
    },
    /*
     * The other half of the same file, and a separate entry because it is a
     * separate question. "Make the console bigger" and "stop every new
     * character resting at 60%" have nothing to do with each other, and one
     * row covering both is how neither gets found.
     */
    {
      id: 'settings-defaults',
      icon: 'settings' as const,
      label: t('palette.character.settingsDefaultsLabel'),
      group: 'character',
      keywords: [
        'global',
        'defaults',
        'default',
        'new',
        'template',
        'combat',
        'health',
        'spells',
        'movement',
        'alerts',
        'encoding',
        'cp437',
        'menus',
        'world',
        'database'
      ],
      movesFocus: true,
      run: deps.editDefaults
    },
    {
      id: 'connection',
      icon: connected ? ('stop' as const) : ('play' as const),
      label: connected
        ? t('palette.character.disconnectLabel')
        : t('palette.character.connectLabel'),
      // Named, because with several characters loaded "connect" is ambiguous
      // and the answer is always "the one you are looking at".
      hint: `${shownName} · ${chord('Enter')}`,
      group: 'character',
      run: deps.toggleConnection
    },
    // Saved realms, so the common case is not retyping a host and port.
    ...deps.servers.map((server) => ({
      id: `server:${server.name}`,
      icon: 'play' as const,
      label: t('palette.character.connectRealmLabel', { realmName: server.name }),
      hint: `${server.host}:${server.port}`,
      group: 'character' as const,
      run: () => deps.connect(targetFromServer(server))
    })),
    // Switching characters, and opening ones that have been closed. Only
    // offered when there is a choice to make.
    ...(sessions.length > 1
      ? sessions
          .filter((entry) => entry.id !== session)
          .map((entry) => ({
            id: `show:${entry.id}`,
            icon: 'user' as const,
            label: t('palette.character.showLabel', { characterName: entry.name }),
            hint: phases[entry.id] ?? t('palette.character.showIdleStatus'),
            group: 'character' as const,
            run: () => deps.showSession(entry.id)
          }))
      : []),
    ...profiles
      .filter((profile) => !profile.loaded)
      .map((profile) => ({
        id: `open:${profile.id}`,
        icon: 'login' as const,
        label: t('palette.character.openLabel', { characterName: profile.name }),
        hint: `${profile.target.host}:${profile.target.port}`,
        group: 'character' as const,
        run: () => void api.loadProfile(profile.id)
      })),
    ...(showTabs
      ? [
          {
            id: 'close',
            icon: 'close' as const,
            label: t('palette.character.closeLabel', { characterName: shownName }),
            hint: connected ? t('palette.character.closeDisconnectFirstHint') : undefined,
            group: 'character' as const,
            run: () => deps.closeSession(session)
          }
        ]
      : []),
    /*
     * Moving a character to a window of its own, and back.
     *
     * A command and not a drag, deliberately: Electron has no built-in
     * for dragging a tab between windows, and doing it properly means a
     * hand-rolled drag session, a drop protocol between windows and a
     * fallback for the drag that ends over nothing. This is the whole
     * capability minus the gesture, and the gesture can follow now that
     * the capability is proven (docs/profiles.md §7.4).
     *
     * The session does not move — nothing here touches a socket.
     *
     * Not offered in a browser tab, which has no second window to move
     * anything into: main refuses each of these there with a reason, and
     * the command is withheld as well, because a command that is found and
     * does nothing is worse than one that cannot be found.
     */
    ...(showTabs && api.host !== 'web'
      ? [
          {
            id: 'popout',
            icon: 'popout' as const,
            label: t('palette.character.popoutLabel', { characterName: shownName }),
            hint: sessions.length > 1 ? undefined : t('palette.character.popoutOnlyHint'),
            group: 'character' as const,
            movesFocus: true,
            run: () => {
              void api.popOut(session).then((refused) => {
                if (refused !== null) deps.terminal()?.notice(refused);
              });
            }
          },
          {
            id: 'popin',
            icon: 'popin' as const,
            label: t('palette.character.popinLabel', { characterName: shownName }),
            group: 'character' as const,
            run: () => {
              void api.popIn(session);
            }
          },
          {
            /*
             * Main does this, not the renderer: a window's roster is only
             * what it holds tabs for, so it cannot ask for the characters it
             * has lost sight of — which is exactly the ones this is for.
             */
            id: 'gather',
            icon: 'users' as const,
            label: t('palette.character.gatherLabel'),
            group: 'character' as const,
            run: () => {
              void api.gatherWindows();
            }
          }
        ]
      : []),

    // Navigate: getting somewhere, in the room graph or in the backscroll.
    {
      id: 'route',
      icon: 'route' as const,
      label: t('palette.navigate.routeLabel'),
      hint: chord('G'),
      group: 'navigate',
      // The panel takes the caret itself.
      movesFocus: true,
      run: deps.openRoute
    },
    /*
     * Where a loop is drawn. Beside the route, because it is the same
     * gesture on the same map with a file at the end of it. Its id is
     * deliberately not `loop:…` — the shipped shelf pins `loop:*`, and
     * pinned it sorted above the Route command, so typing `route` opened
     * the builder on Enter (the smoke run caught it) — and its keywords
     * are the words nothing else has earned: `route` is the panel's and
     * `loop` is the shelf's.
     */
    {
      id: 'builder:open',
      icon: 'flag' as const,
      label: t('palette.navigate.buildLabel'),
      group: 'navigate' as const,
      keywords: ['build', 'create', 'draw', 'make', 'new', 'waypoint', 'path', 'editor'],
      run: deps.openBuilder
    },
    /*
     * The question an evening starts with, and the one the client could
     * price all along and never did (todo 05). Brings the Hunting card out;
     * the card asks main from where the character stands.
     */
    {
      id: 'hunt:where',
      icon: 'search' as const,
      label: t('palette.navigate.huntLabel'),
      group: 'navigate' as const,
      keywords: ['hunt', 'hunting', 'where', 'lair', 'exp', 'experience', 'grind', 'rate', 'spot'],
      run: () => cards.show('hunting')
    },
    {
      id: 'search',
      icon: 'search' as const,
      label: t('palette.navigate.searchLabel'),
      hint: chord('F'),
      group: 'navigate',
      keywords: ['find', 'search', 'backscroll', 'scrollback', 'history'],
      // The bar takes the caret itself, so the automatic return would fight it.
      movesFocus: true,
      run: deps.openSearch
    },

    // View: how the client presents itself, rather than what it is doing.
    {
      id: 'rail',
      icon: 'activity' as const,
      label: deps.railOpen
        ? t('palette.view.hideDiagnosticsLabel')
        : t('palette.view.showDiagnosticsLabel'),
      hint: chord('D', true),
      group: 'view',
      run: deps.toggleRail
    },
    {
      id: 'debug',
      icon: 'terminal' as const,
      label: deps.debugOpen ? t('palette.view.hideDebugLabel') : t('palette.view.showDebugLabel'),
      hint: t('palette.view.debugHint'),
      group: 'view',
      /*
       * `bug` is the word somebody types and `debug` is what the client
       * calls it; `raw`, `ansi`, `parse` and `trace` are what they are
       * actually looking for when they do not know either.
       */
      keywords: ['debug', 'bug', 'report', 'raw', 'ansi', 'parse', 'trace', 'diagnose'],
      run: deps.toggleDebug
    },
    {
      id: 'jump',
      icon: 'jumpDown' as const,
      label: t('palette.view.jumpLabel'),
      hint: chord('L', true),
      group: 'view',
      run: () => deps.terminal()?.jumpToLatest()
    },
    {
      id: 'hud',
      icon: 'layout' as const,
      label:
        deps.hud === 'on' ? t('palette.view.hideCardsLabel') : t('palette.view.showCardsLabel'),
      hint: deps.inGame ? undefined : t('palette.view.hudNotInRealmHint'),
      group: 'view',
      keywords: ['hud', 'cards', 'rail', 'panel'],
      run: () => deps.setHud(deps.hud === 'on' ? 'off' : 'on')
    },
    {
      id: 'density',
      icon: 'density' as const,
      label: t('palette.view.densityLabel'),
      hint:
        deps.densityPreference === 'auto'
          ? t('palette.view.densityAutoHint', { density: deps.density })
          : deps.density,
      group: 'view',
      keywords: ['density', 'compact', 'comfortable', 'spacing', 'size'],
      run: deps.cycleDensity
    },
    {
      id: 'focus',
      icon: 'terminal' as const,
      label: t('palette.view.focusLabel'),
      group: 'view',
      keywords: ['focus', 'terminal', 'console', 'caret', 'cursor'],
      run: () => deps.terminal()?.focus()
    },
    /*
     * The shelf itself, above the loops this character already has.
     *
     * A command as well as a chord and a button, for the reason the palette
     * exists: `Ctrl/Cmd L` is invisible to somebody who has not read the
     * documentation, and `loop`, `grind` and `walk` are what they type. It
     * `movesFocus`, because the modal takes the caret — the opt-out
     * `Command` provides for exactly this, and without it the automatic
     * return would undo the focus move the moment the palette closed.
     */
    {
      id: 'loop:open',
      icon: 'loop' as const,
      label: t('loops.paletteLabel'),
      group: 'navigate' as const,
      /*
       * Deliberately not `route`. A keyword is what somebody types looking
       * for a thing, and `route` is what they type looking for the *route
       * panel* — which is a different command that has owned that word since
       * before this one existed. This command is pinned by the shipped
       * `loop:*` pattern, so it sorts above the shelf's other rows: claiming
       * `route` as well put it above the Route command itself and Enter
       * opened the wrong thing. A keyword is only free if nothing else has
       * earned it.
       */
      keywords: ['loop', 'loops', 'grind', 'walk', 'shelf', 'megamud', 'area'],
      movesFocus: true,
      // Through the toggle, so the "a character exists" guard is stated once
      // rather than once per way in.
      run: deps.toggleLoops
    },
    // Loops: the loop a character walks to gain levels. Asked of the
    // session rather than read off the global config, because a profile
    // overlay replaces `automation.loops` — the global list is the wrong
    // answer for any character that states its own.
    ...deps.loops.map((loop) => ({
      id: `loop:${loop.name}`,
      icon: 'route' as const,
      label: t('palette.navigate.loopLabel', { loopName: loop.name }),
      hint:
        loop.stops === 1
          ? t('palette.navigate.loopStopsHint.one', { stopCount: loop.stops })
          : t('palette.navigate.loopStopsHint.many', { stopCount: loop.stops }),
      keywords: ['loop', 'grind', 'walk'],
      group: 'navigate' as const,
      run: () => {
        void api.startLoop(session, loop.name).then((refused) => {
          if (refused) deps.say(session, refused);
        });
      }
    })),
    /*
     * Stop, whichever of the two is running — and only while one is: a stop
     * for a character standing still is a control that does nothing, which
     * is worse than none. One command rather than the two it replaced, for
     * the reason the toolbar has one button: *stop* means the same thing
     * whether the character is routing or looping.
     */
    ...(deps.moving
      ? [
          {
            id: 'move:stop',
            icon: 'stop' as const,
            label: t('palette.navigate.moveStopLabel'),
            hint: t('palette.navigate.moveStopHint'),
            keywords: ['loop', 'walk', 'route', 'stop', 'halt', 'move'],
            group: 'navigate' as const,
            run: () => void api.stopMoving(session)
          }
        ]
      : []),
    {
      id: 'theme',
      icon: 'theme' as const,
      label: t('palette.view.themeCycleLabel'),
      hint:
        themes.preference === 'system'
          ? t('palette.view.themeCycleSystemHint', { themeLabel: themes.theme.label })
          : themes.theme.label,
      group: 'view',
      run: themes.cycle
    },
    // One command per theme, so a theme is *chosen* rather than cycled to
    // through fifteen others. Findable by its own name and by "theme".
    ...THEME_PREFERENCES.filter((entry) => entry !== themes.preference).map((entry) => ({
      id: `theme:${entry}`,
      icon: 'theme' as const,
      label:
        entry === 'system'
          ? t('palette.view.themeFollowSystemLabel')
          : t('palette.view.themeLabel', { themeLabel: THEMES[entry].label }),
      hint: entry === 'system' ? t('palette.view.themeSystemHint') : THEMES[entry].appearance,
      keywords: ['theme', 'colour', 'color', 'scheme', 'appearance'],
      group: 'view' as const,
      run: () => themes.choose(entry)
    })),
    // One per console palette, alongside the theme commands rather than
    // buried under them: the console is the surface the player spends the
    // evening reading, and "make the game's colours pop" is not a request
    // anybody should have to find a settings page to make.
    ...CONSOLE_PALETTES.filter((entry) => entry !== themes.consolePreference).map((entry) => ({
      id: `console:${entry}`,
      icon: 'terminal' as const,
      label:
        entry === 'theme'
          ? t('palette.view.consolePaletteFollowLabel')
          : t('palette.view.consolePaletteLabel', {
              paletteLabel: TERMINAL_THEMES[entry].label
            }),
      hint:
        entry === 'theme'
          ? t('palette.view.consolePaletteFollowHint')
          : TERMINAL_THEMES[entry].appearance,
      keywords: ['console', 'terminal', 'palette', 'ansi', 'colour', 'color'],
      group: 'view' as const,
      run: () => themes.chooseConsole(entry)
    })),
    ...(showTabs
      ? [
          {
            id: 'tabside',
            icon: 'columns' as const,
            /*
             * One row that cycles left → top → right, labelled with where
             * the next press puts the rail and hinted with what that costs.
             *
             * A row per placement was the alternative and is what the theme
             * commands do — but a theme has sixteen values and no order,
             * while this has three that are literally one control moved
             * around a window. Three rows would put two dead ones in the
             * `view` group at all times, and the group is already the
             * longest in the palette.
             *
             * The keywords carry what the label cannot: a cycle's label only
             * ever names the *next* stop, so without them somebody typing
             * `right` would find this row only one press in three — and a
             * command nobody can find does not exist.
             */
            label:
              tabSide === 'top'
                ? t('palette.view.tabsOnRightLabel')
                : tabSide === 'left'
                  ? t('palette.view.tabsOnTopLabel')
                  : t('palette.view.tabsOnLeftLabel'),
            hint:
              tabSide === 'top'
                ? t('palette.view.tabsTopHint')
                : tabSide === 'left'
                  ? t('palette.view.tabsLeftHint')
                  : t('palette.view.tabsRightHint'),
            keywords: ['tabs', 'left', 'right', 'top', 'side', 'edge', 'rail', 'mirror', 'swap'],
            group: 'view' as const,
            run: () =>
              deps.setTabSide(tabSide === 'left' ? 'top' : tabSide === 'top' ? 'right' : 'left')
          }
        ]
      : []),
    {
      id: 'config',
      icon: 'fileText' as const,
      label: t('palette.view.configLabel'),
      // The full path stretched the palette into a sideways scroll; the two
      // ends are what identify a path, so the middle is what goes.
      hint: shortPath(deps.configPath),
      group: 'view',
      // `reveal` was the label until it stopped being one; somebody who
      // learned it should still find the row. A label is how a thing reads,
      // keywords are how it is found.
      keywords: ['reveal', 'open', 'yaml', 'file', 'folder', 'config', 'options'],
      run: () => deps.reveal(() => api.revealConfig())
    },
    {
      id: 'profiles',
      icon: 'users' as const,
      label: t('palette.view.profilesLabel'),
      hint:
        sessions.length > 0
          ? t('palette.view.profilesLoadedHint', { count: sessions.length })
          : t('palette.view.profilesNoneHint'),
      group: 'view',
      keywords: ['reveal', 'open', 'folder', 'profiles', 'characters'],
      run: () => deps.reveal(() => api.revealProfiles())
    },
    {
      id: 'logs',
      icon: 'folder' as const,
      label: t('palette.view.logsLabel'),
      hint: deps.loggingEnabled ? undefined : t('palette.view.logsNotKeptHint'),
      group: 'view',
      keywords: ['reveal', 'open', 'folder', 'logs', 'records', 'transcript'],
      run: () => deps.reveal(() => api.revealLogs())
    },

    // Layout: what is on screen and how it is arranged -- panes and cards.
    // Panes: only ever offered when there is something to put in one.
    ...(panes.length < tuning().maxPanes
      ? sessions
          .filter((entry) => !panes.includes(entry.id))
          .map((entry) => ({
            id: `pane:${entry.id}`,
            icon: 'split' as const,
            label: t('palette.layout.splitLabel', { characterName: entry.name }),
            hint:
              paneFlow === 'columns'
                ? t('palette.layout.splitSideBySideHint')
                : t('palette.layout.splitStackedHint'),
            group: 'layout' as const,
            run: () => deps.addPane(entry.id)
          }))
      : []),
    ...(panes.length > 1
      ? [
          {
            id: 'unsplit',
            icon: 'close' as const,
            label: t('palette.layout.unsplitLabel'),
            hint: t('palette.layout.unsplitPanesHint', { paneCount: panes.length }),
            group: 'layout' as const,
            run: deps.closePane
          },
          {
            id: 'paneflow',
            icon: 'columns' as const,
            label:
              paneFlow === 'rows'
                ? t('palette.layout.panesSideBySideLabel')
                : t('palette.layout.panesStackedLabel'),
            hint:
              paneFlow === 'rows'
                ? t('palette.layout.paneflowNeedsColumnsHint', { minColumns: MIN_COLUMNS })
                : t('palette.layout.paneflowRowsCheapHint'),
            group: 'layout' as const,
            run: () => deps.turnPanes(paneFlow === 'rows' ? 'columns' : 'rows')
          }
        ]
      : []),
    // Bringing a card back. Only the ones actually put away, so the palette
    // does not list six things that are already on screen.
    ...cards.away.map((id: CardId) => ({
      id: `card:${id}`,
      icon: 'plus' as const,
      label: t('palette.layout.showCardLabel', { cardName: cardLabel(id) }),
      hint: t('palette.layout.showCardHint'),
      group: 'layout' as const,
      run: () => cards.show(id)
    })),
    /*
     * Whether each card that can be empty holds its place while it is.
     *
     * The same switch the card's own gear carries, in the place people look
     * for things by typing a word — `combat`, `hide`, `party`. Offered only
     * for a card that is actually on screen somewhere: for one that has been
     * put away it is a setting about a card that is not there, the palette
     * already has a row for bringing it back, and a card that is away has no
     * gear to reach either.
     */
    ...(Object.keys(HIDES_WHEN_EMPTY) as CardId[])
      .filter((id) => cards.isShown(id))
      .map((id) => {
        const hides = hidesWhenEmpty(cards.settingsOf(id), id);
        return {
          id: `card:${id}:autohide`,
          icon: 'layout' as const,
          label: hides
            ? t('palette.layout.cardAlwaysLabel', { cardName: cardLabel(id) })
            : t('palette.layout.cardHideEmptyLabel', { cardName: cardLabel(id) }),
          hint: hides ? t('palette.layout.cardAlwaysHint') : t('palette.layout.cardHideEmptyHint'),
          keywords: ['card', 'hide', 'empty', 'autohide', 'show'],
          group: 'layout' as const,
          /*
           * Written only where it differs from this card's own default and
           * cleared where it agrees, so what is stored is what somebody
           * actually chose. A value that happens to equal the default is a
           * key that outlives the default it agreed with.
           */
          run: () =>
            cards.setSettings(id, {
              autoHide: !hides === HIDES_WHEN_EMPTY[id] ? undefined : !hides
            })
        };
      }),
    // The way out of a rail that has been dragged into a corner. Kept in the
    // palette rather than on the rail: it is reached once, by someone who
    // already knows they want it. A rail rolled flat is that corner too, so
    // it counts — `reset` puts the rolled cards back open with the rest of
    // the arrangement.
    ...(cards.floats.length > 0 || cards.away.length > 0 || cards.rolled.length > 0
      ? [
          {
            id: 'cards:reset',
            icon: 'reset' as const,
            label: t('palette.layout.resetCardsLabel'),
            hint: t('palette.layout.resetCardsHint'),
            group: 'layout' as const,
            run: () => cards.reset()
          }
        ]
      : []),
    // A rail dragged somewhere awkward, put back to the density's default.
    ...(widths.rail !== null ||
    widths.tabs !== null ||
    widths.above !== null ||
    widths.below !== null
      ? [
          {
            id: 'layout:widths-reset',
            icon: 'reset' as const,
            label: t('palette.layout.widthsResetLabel'),
            hint: t('palette.layout.widthsResetHint'),
            keywords: ['resize', 'splitter', 'divider', 'width', 'rail', 'column'],
            group: 'layout' as const,
            run: () => widths.reset()
          }
        ]
      : [])
  ];
}
