import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import CommandPalette, { type Command } from './components/CommandPalette';
import SearchBar from './components/SearchBar';
import RoutePanel from './components/RoutePanel';
import CardRailHead from './components/CardRailHead';
import RailGrid from './components/RailGrid';
import { NARROWEST_RAIL } from './lib/railCards';
import { CONSOLE_RANGE } from './lib/splitter';
import StripCards from './components/StripCards';
import DragMarks from './components/DragMarks';
import FloatLayer from './components/FloatLayer';
import PinnedFloats from './components/PinnedFloats';
import SettingsScreen from './components/SettingsScreen';
import SessionTerminal from './components/SessionTerminal';
import SlideOuts from './components/SlideOuts';
import TabRail, { type RailSide } from './components/TabRail';

import DebugView from './components/DebugView';
import type { DebugRecord } from '@shared/debug';
import StatusRail from './components/StatusRail';
import LoopsModal from './components/LoopsModal';
import HomeBrowser from './components/HomeBrowser';
import HelpScreen from './components/HelpScreen';
import { TOOLBAR_ACTIONS } from './lib/toolbar';
import { liveSheetOf } from './lib/liveSheet';
import { useToolbarPins } from './hooks/useToolbarPins';
import { type TerminalHandle } from './components/TerminalView';
import { useConfig } from './hooks/useConfig';
import { useConnection } from './hooks/useConnection';
import { useDiagnosticFeeds } from './hooks/useDiagnosticFeeds';
import { useNameIndexes } from './hooks/useNameIndexes';
import { useNavigationVisible } from './hooks/useNavigationVisible';
import { measureAbove, measureBelow, measureTabs, usePaneRanges } from './hooks/usePaneRanges';
import { useCardLayout } from './hooks/useCardLayout';
import { useCardChrome } from './hooks/useCardChrome';
import { useCardContext } from './hooks/useCardContext';
import { useCardRenderers } from './hooks/useCardRenderers';
import { usePaneWidths } from './hooks/usePaneWidths';
import { useConsoleWidth } from './hooks/useConsoleWidth';
import { useLoopBuilder } from './hooks/useLoopBuilder';
import { useLoopsModal } from './hooks/useLoopsModal';
import { useHelpScreen } from './hooks/useHelpScreen';
import { useLoopJoin } from './hooks/useLoopJoin';
import { useMovement } from './hooks/useMovement';
import { usePanes } from './hooks/usePanes';
import { useProfileReaders } from './hooks/useProfileReaders';
import { useRoutePanel } from './hooks/useRoutePanel';
import { useSearchBar } from './hooks/useSearchBar';
import { useSettingsScreen } from './hooks/useSettingsScreen';
import { useSettingsApi } from './hooks/useSettingsApi';
import { useGameView } from './hooks/useGameView';
import GameView from './components/game/GameView';
import { cardElement } from './components/CardSwitch';
import { useRouteOpeners } from './hooks/useRouteOpeners';
import { useRecentMenu } from './hooks/useRecentMenu';
import { useShownRealm } from './hooks/useShownRealm';
import { useSlideOuts } from './hooks/useSlideOuts';
import { EMPTY_VIEW, useSessionViews } from './hooks/useSessionViews';
import { usePinnedCommands } from './hooks/usePins';
import { Splitter } from './components/Splitter';
import { useCardDrag } from './hooks/useCardDrag';
import { useCommandPalette } from './hooks/useCommandPalette';
import { useHomeBrowser } from './hooks/useHomeBrowser';
import { useAutoLayout } from './hooks/useAutoLayout';
import { useRailGrid } from './hooks/useRailGrid';
import { useDensity } from './hooks/useDensity';
import { useAlerts } from './hooks/useAlerts';
import { useAlertSounds } from './hooks/useAlertSounds';
import { useDesktopAlerts } from './hooks/useDesktopAlerts';
import { useHotkeys } from './hooks/useHotkeys';
import { useBoundKeys } from './hooks/useBoundKeys';
import { CLIENT_KEYS } from '@shared/keys';
import { useOverridablePreference, useOverridableSwitch } from './hooks/usePreference';
import { useTheme } from './hooks/useTheme';
import { useStreamPressure } from './hooks/useStreamPressure';
import { t } from './lib/i18n';
import { paletteCommands, paletteKeys, type PaletteDeps } from './lib/palette';
import { paletteFind } from './lib/paletteFind';
import { statusAction } from './lib/statusAction';
import {
  AUTOMATION_SWITCH_NAMES,
  resolveTerminalFonts,
  resolveUiFonts,
  toCssFontStack
} from '@shared/config';
import { figuresOf, type StatlineFigures } from '@shared/statline';
import { DEFAULT_INTERNAL, type InternalConfig } from '@shared/internal';
import { roomsWithFinds } from '@shared/finds';
import { movementOf } from '@shared/movement';
import { IDLE_QUEST_RUN } from '@shared/quests';
import MovementPrompt from './components/MovementPrompt';
import ResetGate from './components/ResetGate';
import LowLivesPrompt from './components/LowLivesPrompt';
import { useLowLivesAsk } from './hooks/useLowLivesAsk';
import { useConsoleNotices } from './hooks/useConsoleNotices';
import TripDialogs from './components/TripDialogs';
import { useTripDialogs } from './hooks/useTripDialogs';
import { type ProfileSummary, type SessionId, type SessionSummary } from '@shared/ipc';
import type { ConnectionState, TerminalSize } from '@shared/types';
import { setTuning } from './lib/tuning';

/** No characters loaded: one empty list, so the rail's props hold still while it is empty. */
const NO_SESSIONS: SessionSummary[] = [];

export default function App() {
  const api = window.mudengine;

  /**
   * Every character the client has loaded, and the one this window is showing.
   *
   * Still exactly one — the tab rail arrives next — but it is now a real
   * profile id rather than a placeholder, so the call sites already name the
   * character they mean and do not change when the rail picks a different one.
   */
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);

  const { config, path: configPath, loadedAt } = useConfig();

  const [size, setSize] = useState<TerminalSize>({ cols: 80, rows: 24 });

  /**
   * Every mounted terminal, by character.
   *
   * They all stay mounted (see `SessionTerminal`), so this is how the window
   * reaches the one it is showing — to focus it, to search it, or to print an
   * engine message into it.
   */
  const terminals = useRef(new Map<SessionId, TerminalHandle>());
  /** A sentence into one character's console: a refusal, said where it applies. */
  const noticeTo = useCallback((sid: SessionId, message: string): void => {
    terminals.current.get(sid)?.notice(message);
  }, []);

  /**
   * Close a character's tab.
   *
   * Refused while it is connected, and it says so rather than asking. The
   * character is right there in the command strip with a Disconnect button, and
   * a confirmation dialog for something one click away is a dialog people learn
   * to dismiss without reading — which is exactly the wrong habit for the one
   * gesture that can drop a character in a dangerous room.
   */
  const closeSession = useCallback(
    (id: SessionId) => {
      void api.unloadProfile(id).then((refused) => {
        if (refused) noticeTo(id, t('notices.session.closeRefused', { refusalReason: refused }));
      });
    },
    [api, noticeTo]
  );

  /** The characters on screen, one per pane, and which pane the keyboard is talking to. */
  const {
    panes,
    paneAt,
    session,
    paneFlow,
    layersRef,
    showSession,
    stepSession,
    focusPane,
    addPane,
    turnPanes,
    closePane
  } = usePanes(sessions, noticeTo);

  /** Every session is a character with a name worth showing; none is no rail. */
  const showTabs = sessions.length > 0;

  /*
   * The sessions with a file behind them, which is what "edit" needs. A session
   * whose file was deleted while it was connected stays until it is idle, and
   * has nothing to open.
   */
  const editable = useMemo(() => profiles.map((profile) => profile.id), [profiles]);

  /**
   * Whether the profile list has arrived at all.
   *
   * It comes by push, so `profiles` is `[]` both before the first push and when
   * there genuinely are none — and only the second means anything. Opening the
   * new-character form on the first would flash it at every launch.
   */
  const [profilesKnown, setProfilesKnown] = useState(false);

  /** What each fact arriving for a character is worth saying, by the player's own rows. */
  const alerts = useAlerts(config.ui.vitals, config.ui.alerts);
  /** The facts about every character, kept for every character. */
  const { views, patchView, applySnapshot, resetStats } = useSessionViews(api, alerts, panes);

  const view = views[session] ?? EMPTY_VIEW;
  const { state, character, walk, automation } = view;
  const [internalConfig, setInternalConfig] = useState<InternalConfig>(DEFAULT_INTERNAL);
  useEffect(() => {
    /*
     * The `tuning:` half goes to `lib/tuning.ts` rather than into state.
     *
     * Those numbers are limits, delays and thresholds read at the moment they
     * are needed — by a reducer, a pointer handler, a debounce — none of which
     * has a prop to carry one, and none of which needs the window to re-render
     * because somebody edited a millisecond. The rest of the file *is* state:
     * the palette shelf and the toolbar row are drawn from it.
     */
    const take = (next: InternalConfig): void => {
      setTuning(next.tuning.view);
      setInternalConfig(next);
    };
    void api.getInternal().then(take);
    return api.onInternal(take);
  }, [api]);
  const [loops, setLoops] = useState<Array<{ name: string; stops: number }>>([]);
  useEffect(() => {
    let stale = false;
    void api.listLoops(session).then((list) => {
      if (!stale) setLoops(list);
    });
    return () => {
      stale = true;
    };
    /*
     * Re-asked on both signals a loop set can move under, because `loadedAt`
     * alone covers only one of the three scopes.
     *
     * A **global** loop appearing folds into the configuration through
     * `setExtras`, which republishes and bumps `loadedAt`. A **realm's** or a
     * **character's own** loop does not: `setExtras` compares what it is handed
     * and returns without emitting when the servers and the global loops are
     * unchanged, which they are. What does move is `Push.profiles` --
     * `LoopStore`'s change calls `profiles.refresh()`, precisely because a
     * narrower scope reaches a character only by re-resolving it, and that
     * emits unconditionally.
     *
     * So `profiles` is the dependency for the two narrow scopes. It is not a
     * second source of truth: `loop:list` is still the one query, still
     * resolved live off the SessionManager, and this only says when to ask it
     * again. `Push.loop` deliberately does not appear here -- that is per-run
     * *progress*, not a catalogue signal.
     */
  }, [api, session, loadedAt, profiles]);

  const { density, preference, cycle } = useDensity(config.ui.density);
  /*
   * The shown character's theme, when its file states one; the options file's
   * otherwise. A palette pick still outranks either until the file changes,
   * which is `useOverridablePreference`'s rule and is unchanged here.
   */
  const characterTheme = profiles.find((profile) => profile.id === session)?.theme;

  /** Each character's own resolved settings, off its profile. */
  const { remotesFor, suppliesFor, profileNameFor, switchesFor, restToFor } =
    useProfileReaders(profiles);
  /**
   * What this character's percentages are percentages *of*, and its picklocks
   * and Meditate, for the settings screen's fields (todo 50).
   *
   * Read off the live view rather than carried on the settings snapshot: a
   * maximum comes from the stat sheet and moves when the character levels, and
   * a figure baked into a snapshot taken when the dialog opened would be
   * confidently stale. All are null for a character not in the realm, which is
   * the answer `figureOf` draws as nothing at all.
   */
  const sheetFor = useCallback((id: SessionId) => liveSheetOf(views[id]), [views]);
  // The designed status line's preview draws the character's own figures only
  // while it is in the realm; anything else is a sample, not a set of dashes.
  const figuresFor = useCallback(
    (id: SessionId): StatlineFigures | null => {
      const character = views[id]?.character;
      return character && character.phase === 'in-game' ? figuresOf(character) : null;
    },
    [views]
  );
  const {
    theme,
    consolePalette,
    preference: themePreference,
    consolePreference,
    cycle: cycleTheme,
    choose: chooseTheme,
    chooseConsole
  } = useTheme(
    characterTheme ?? config.ui.theme,
    config.ui.console.keepDark,
    config.ui.console.darkTheme,
    config.ui.console.palette
  );

  /* Same precedence as density and theme: a palette toggle is remembered until an edit to
     `ui.showHud` or `terminal.timestamps` in the options file overrides it. */
  const [hud, setHud] = useOverridableSwitch('mudengine.hud', config.ui.showHud);
  const [times, setTimes] = useOverridableSwitch('mudengine.times', config.terminal.timestamps);
  /**
   * The diagnostics cards, for this run of the client only.
   *
   * Deliberately *not* remembered and deliberately not configurable — the one
   * piece of chrome here that is neither. Link, traffic and stream readouts are
   * what you open when something looks wrong on the wire; they are a tool
   * reached for, used, and put down, not part of how a player has arranged
   * their instrument. Left remembered, an evening's debugging becomes the
   * client's permanent shape, and the cost is paid on the rail every launch
   * afterwards by somebody who has forgotten they ever asked.
   *
   * So the client always starts with them hidden, the palette toggle shows them
   * for as long as this window is open, and closing the client puts them away.
   * `ui.showDiagnostics` was removed with this rather than being left to mean
   * nothing: a setting that cannot take effect is worse than one not offered.
   */
  const [railOpen, setRailOpen] = useState(false);
  /**
   * Whether the debug view is over the console.
   *
   * A plain `useState`, and hidden on every launch, for exactly the reason the
   * diagnostics rail is: this is a tool reached for when something looks wrong
   * and put down again, not part of how a player has arranged their
   * instrument. Made configurable it would become somebody's permanent client
   * because of one evening's debugging — which is the complaint
   * `ui.showDiagnostics` was deleted over.
   */
  const [debugOpen, setDebugOpen] = useState(false);

  /** Same precedence as density and theme: remembered, overridden by the file. */
  const [tabSide, setTabSide] = useOverridablePreference<RailSide>(
    'mudengine.tabs',
    config.ui.tabs,
    (value): value is RailSide => value === 'top' || value === 'left' || value === 'right'
  );
  /*
   * Which edge the *cards* take, which is the other one.
   *
   * One setting decides both, because the two side rails cannot share an edge:
   * a client that let each be asked for independently would have to pick a
   * winner when both said left, and the pick would be arbitrary. So the tab
   * rail's side is the setting and the card rail takes what is left.
   *
   * Stated as its own attribute rather than read off `data-tabs` in the
   * stylesheet, because it has to hold in the one state where there is no tab
   * rail at all — a client with no characters yet. Keyed on the tabs, the card
   * rail would sit on the right until the first character loaded and then jump
   * across the window.
   */
  const railSide: 'left' | 'right' = tabSide === 'right' ? 'left' : 'right';

  /**
   * How this character's rail is arranged, remembered per character.
   *
   * Which cards are on it, in what order, which have been lifted off onto the
   * console and how far through each of those you can see. A healer watches
   * different things from a warrior, and arranges them differently.
   */
  const cards = useCardLayout(session);

  /*
   * The console's columns and the tab rail's width, dragged and remembered per
   * client. The range a drag may move within is computed when the gesture
   * starts, from the console as laid out and the terminal's measured cell
   * width — so the floor is eighty *measured* columns, never a pixel constant
   * (docs/ui-design.md §3.8).
   */
  const widths = usePaneWidths();
  /* The console is the chosen columns a pane across; the card rail takes the rest. */
  const across = paneFlow === 'columns' ? panes.length : 1;
  const consoleWidth = useConsoleWidth(size.cols, across, widths.columns);
  const workspaceStyle = useMemo(
    () => ({ ...widths.style, ...consoleWidth, '--card-columns': NARROWEST_RAIL }) as CSSProperties,
    [widths.style, consoleWidth]
  );
  const [resizing, setResizing] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  /* The card rail's grid, which a drop and a resize are measured against. */
  const railGrid = useRailGrid();
  const drag = useCardDrag(cards, workspaceRef, railGrid.view);
  const autoLayout = useAutoLayout(session, cards, railGrid.view);

  /** What each splitter measures, and the range a drag of it may move within. */
  const {
    measureConsole,
    rangeForConsole,
    setConsole,
    resetConsole,
    rangeForTabs,
    rangeForAbove,
    rangeForBelow,
    resetTabs,
    resetAbove,
    resetBelow
  } = usePaneRanges(layersRef, size, across, widths);

  const { pressure, meter, record, reset } = useStreamPressure();

  const action = useMemo(() => statusAction(walk, automation.queue), [walk, automation.queue]);

  const terminalFonts = useMemo(
    () => toCssFontStack(resolveTerminalFonts(config.terminal.font.family)),
    [config.terminal.font.family]
  );

  const uiFonts = useMemo(
    () => toCssFontStack(resolveUiFonts(config.ui.font.family)),
    [config.ui.font.family]
  );

  /**
   * Chrome typography is published as tokens rather than passed down as props:
   * `tokens.css` is the only place literal values live, and every component
   * already reads `--font-ui-family` from there, so a config reload repaints
   * the whole shell without a single component knowing about the config.
   */
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--font-ui-family', uiFonts);
    root.setProperty('--font-ui-base', `${config.ui.font.size}px`);
    // The slate must not inherit chrome typography: `ui.font` may legitimately
    // be proportional, and the terminal cell never may. This also makes the
    // resolved console stack observable from the DOM, which xterm's canvas
    // renderer otherwise hides.
    root.setProperty('--font-terminal', terminalFonts);
  }, [uiFonts, config.ui.font.size, terminalFonts]);

  /** Bumped when a terminal registers or leaves, so effects can react to it. */
  const [handleTick, setHandleTick] = useState(0);

  /** The character on screen, for callbacks that must not go stale. */
  const activeRef = useRef(session);
  useEffect(() => {
    activeRef.current = session;
  }, [session]);

  const registerHandle = useCallback((id: SessionId, handle: TerminalHandle | null) => {
    if (handle) terminals.current.set(id, handle);
    else terminals.current.delete(id);
    setHandleTick((n) => n + 1);
  }, []);

  const activeTerminal = useCallback(
    (): TerminalHandle | null => terminals.current.get(activeRef.current) ?? null,
    []
  );

  /**
   * The focus policy, in one place.
   *
   * The terminal is where focus lives. Chrome may take it — the palette needs
   * to be typed into, the connection fields need to be edited — but every one
   * of those interactions ends by handing it back, so the user is never left
   * typing into a button. With several characters, "the terminal" means the one
   * being shown. See docs/ui-design.md §3.6.
   *
   * Deferred a frame so it lands after React has committed whatever closed; a
   * command that parks focus elsewhere on purpose opts out with `movesFocus`.
   *
   * **And it stands down for a dialog that has taken the caret meanwhile.** A
   * palette command that reveals a path answers from main a moment later, and
   * the home browser that answer opens focuses itself on mount — in the same
   * frame this deferred return was waiting for. Unconditional, the return took
   * the caret back off the dialog, its own Escape then went to the game, and
   * the web smoke's Escape on the options-file listing failed two runs in
   * three (2026-09-07). A dialog hands the caret back on its own exit, which is
   * the rule that makes standing down here correct rather than lenient.
   */
  // The game view, or the classic one (todo 140); its command layer is where focus settles.
  const game = useGameView(config.gameView, activeTerminal, size.cols);
  const returnFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      if (document.activeElement?.closest('[role="dialog"]') || game.takeFocus()) return;
      activeTerminal()?.focus();
    });
  }, [activeTerminal, game.takeFocus]);
  const { asked: livesAsked, answer: answerLowLives } = useLowLivesAsk(api, returnFocus);

  /*
   * The modals that hold the caret and hand it back on their own exit, each
   * with the state it owns (todo 732).
   */
  const {
    open: paletteOpen,
    openPalette,
    close: closePalette,
    toggle: togglePalette
  } = useCommandPalette(returnFocus);
  const {
    open: routeOpen,
    destination: routeTarget,
    search: routeSearch,
    joining: routeJoining,
    close: closeRoute,
    openOn: openRouteOn,
    openToJoin,
    openCold: openRoute,
    toggleCold: toggleRoute
  } = useRoutePanel(returnFocus);
  const {
    open: searchOpen,
    result: searchResult,
    setResult: setSearchResult,
    openSearch,
    close: closeSearch,
    toggle: toggleSearch,
    run: runSearch
  } = useSearchBar(activeTerminal, returnFocus);
  const {
    open: loopsOpen,
    toggle: toggleLoops,
    close: closeLoops,
    loading: loopsLoading,
    rows: loopChoices,
    here: loopHere
  } = useLoopsModal({
    api,
    session,
    loops,
    recent: view.loop.name,
    room: character.room,
    returnFocus,
    say: noticeTo
  });
  const trips = useTripDialogs(session, returnFocus);
  const { helpOpen, toggleHelp, closeHelp } = useHelpScreen(returnFocus);

  /** What the shown character asks its realm. */
  const {
    searchRooms,
    walkRoute,
    collectThenWalk,
    loadMap,
    loadRoomBrief,
    loadWearer,
    lookupName,
    ask,
    forget,
    routeTo
  } = useShownRealm({ api, session });
  /** The route panel opened on a room pointed at, by a map, a name or a quest step. */
  const { chooseOnMap, chooseRoomNamed, goToRoom } = useRouteOpeners({ api, session, openRouteOn });
  /**
   * Where this realm's find log says something was turned up, for the route
   * panel's picture — the mark the Map card draws from the same log.
   *
   * Here because the panel belongs to the character on screen; a *card*
   * computes its own, addressed at the character it was drawn for, as every
   * other world fact in this file is.
   */
  const foundRooms = useMemo(() => [...roomsWithFinds(view.finds)], [view.finds]);

  /** The panels that hang off a name, one at a time. */
  const slideOuts = useSlideOuts(session, chooseOnMap);
  const { asked, flyout, inspect, selectPlayer, peekRoom, peekPlanned, endPeek } = slideOuts;

  const { browsing, close: closeBrowser, reveal } = useHomeBrowser(returnFocus);

  /**
   * Say the client is ready exactly once.
   *
   * It used to be announced by the terminal registering, which was one event
   * while there was one terminal. There are now several, and each of them
   * announcing would be several — the autoconnect latch in main is built for
   * exactly that mistake, but relying on it would be relying on someone else's
   * guard rather than not making the noise.
   */
  useEffect(() => {
    api.clientReady();
  }, [api]);

  /**
   * Focus follows the shown character.
   *
   * Switching tabs is a statement about where you intend to type, so the caret
   * goes with it. Also covers the first terminal appearing, which is rule one:
   * the client opens ready to type at.
   */
  useEffect(() => {
    const handle = terminals.current.get(session);
    if (!handle) return;
    window.requestAnimationFrame(() => handle.focus());
  }, [session, handleTick]);

  const sayOnScreen = useConsoleNotices(api, terminals, activeRef, session, sessions, handleTick);

  /**
   * Throughput is reported for the character being watched.
   *
   * The status rail describes the slate in front of you; summing four
   * characters into one number would describe nothing anyone is reading.
   */
  const noteChunk = useCallback(
    (id: SessionId, chars: number) => {
      if (id === activeRef.current) record(chars);
    },
    [record]
  );

  /** The per-line and debug feeds, sent only while something here shows them. */
  const noteStreamFloat = useDiagnosticFeeds({
    api,
    sessions,
    railOpen,
    streamFloating: cards.floatOf('stream') !== undefined,
    debugOpen,
    patchView
  });

  /**
   * Reclaim focus when the window comes back, but only if nothing in the
   * chrome holds it. Leaving focus in the host field, alt-tabbing away and
   * coming back should not silently move the caret.
   */
  useEffect(() => {
    const onWindowFocus = (): void => {
      const active = document.activeElement;
      if (!active || active === document.body) returnFocus();
    };
    window.addEventListener('focus', onWindowFocus);
    return () => window.removeEventListener('focus', onWindowFocus);
  }, [returnFocus]);

  /*
   * The lists of tabs and characters, which are about the client rather than
   * a character's facts (`useSessionViews` keeps those).
   */
  useEffect(() => {
    const off = [
      // Not addressed: these *are* the lists of addresses.
      api.onSessions(setSessions),
      api.onProfiles((list) => {
        setProfiles(list);
        setProfilesKnown(true);
      })
    ];

    return () => off.forEach((unsubscribe) => unsubscribe());
  }, [api]);

  /*
   * The roster is pushed on `clientReady`, but a window that reloads can listen
   * a moment later than the push. Asking once closes that window; the push
   * keeps it current afterwards.
   */
  useEffect(() => {
    void api.listSessions().then(setSessions);
  }, [api]);

  const mustMakeCharacter = profilesKnown && profiles.length === 0 && sessions.length === 0;
  const {
    open: settingsOpen,
    openAt: settingsAt,
    close: closeSettings,
    openSettings,
    editCharacter,
    openSetting,
    newCharacter,
    manageServers,
    editGlobal,
    editDefaults
  } = useSettingsScreen(mustMakeCharacter, returnFocus);

  /** Whether the Navigation card is worth the space it takes. */
  const navigationVisible = useNavigationVisible(
    walk,
    view.loop,
    character.phase === 'in-game',
    loops.length,
    config.automation.walk.clearAfterSeconds
  );

  const inGame = character.phase === 'in-game';
  /*
   * The HUD is on because the player asked for it, not because the character
   * happens to be in the realm.
   *
   * It used to require both, so the whole rail vanished the moment a character
   * dropped — and with two on screen that reads as damage rather than as
   * "offline": one has an instrument beside it and the other has a blank
   * column, with nothing on screen saying which. It also moved the console's
   * width, which re-wraps a scrollback nobody asked to re-wrap.
   *
   * So the rail keeps its space and says what it is waiting for instead.
   */
  const hudOpen = hud === 'on';
  /**
   * The HUD appears on its own, without the diagnostics rail.
   *
   * Vitals and Room are what the player reads while playing; putting them
   * behind a toggle labelled "diagnostics" meant they were never seen. The rail
   * is therefore present whenever there is *either* HUD content or diagnostics
   * to show, and each half decides for itself.
   */
  const railVisible = hudOpen || railOpen;
  const railShown = railOpen && !game.on;

  const connected = state.phase === 'connected';

  /** Dialling and hanging up, the shown character's and any tab's own. */
  const { dial, hangUp, handleConnect, toggleSessionConnection, toggleConnection } = useConnection({
    api,
    session,
    shown: activeRef,
    views,
    patchView,
    connected,
    reset
  });
  // The keys bound to a line, MegaMUD's macros, for the character on screen (todo 74).
  useBoundKeys(api, activeRef, session, profiles, config.keys);

  /*
   * The alerts worth saying outside the window, and a row's sound (todo 80),
   * read from what landed in each log (`views`): a state updater may run twice.
   */
  const openAlerted = useCallback(
    (id: SessionId) => {
      // The window first: a tab switched behind a window nobody can see is a
      // notification that did nothing.
      void api.raiseWindow();
      showSession(id);
    },
    [api, showSession]
  );
  useDesktopAlerts({
    subjects: views,
    // The player's own rows, and the only thing that decides what is raised
    // outside the window: a row marked `notify`, and its own `whileFocused`.
    rules: config.ui.alerts.rules,
    onOpen: openAlerted,
    say: sayOnScreen
  });
  useAlertSounds({ subjects: views, rules: config.ui.alerts.rules });

  /**
   * The rail, dragged into a new order.
   *
   * Optimistic *and* authoritative: the local list is set at once so the tab
   * does not snap back under the pointer for a round trip, and main republishes
   * the roster from what it actually wrote down — so if it declined any part of
   * the order (a tab this window does not own, a character closed mid-drag)
   * the rail ends up showing what was kept rather than what was asked for.
   *
   * The order belongs to the *window*, like the roster it reorders. That is why
   * it goes to main rather than into `localStorage` beside the card layout: a
   * popped-out character has no tab here to be ordered, and `workspace.json`
   * is already where which-window-holds-which-tab is remembered.
   */
  const reorderSessions = useCallback(
    (order: SessionId[]) => {
      setSessions((current) => {
        const by = new Map(current.map((entry) => [entry.id, entry] as const));
        const next = order.map((id) => by.get(id)).filter((entry) => entry !== undefined);
        // A character closed between the drag starting and this landing is not
        // in the map; anything the drag never named keeps its place at the end.
        const named = new Set(order);
        return [...next, ...current.filter((entry) => !named.has(entry.id))];
      });
      void api.reorderSessions(order);
    },
    [api]
  );

  /** The banner's Stop, addressed at the pane's own character; one function for every pane. */
  const stopRunFor = useCallback((sid: SessionId) => void api.questStop(sid), [api]);

  /**
   * The rail takes no typed input, so opening it leaves focus in the terminal
   * and there is nothing to hand back on close.
   */
  const toggleRail = useCallback(() => setRailOpen((open) => !open), []);

  /**
   * The debug view's three doors into main, bundled once.
   *
   * A bundle rather than three props threaded through, and memoised on `api`
   * alone, because a fresh object per render would defeat the view's own memo
   * — and this view subscribes to the densest feed in the client, so it is the
   * last one that should be rebuilt for nothing.
   */
  const debugApi = useMemo(
    () => ({
      load: (sid: SessionId) => api.getDebug(sid),
      save: (sid: SessionId) => api.saveDebug(sid),
      reveal: () => reveal(() => api.revealLogs()),
      unread: (sid: SessionId) => api.getUnread(sid),
      subscribe: (handler: (sid: SessionId, record: DebugRecord) => void) =>
        api.onDebug(({ session: sid, payload }) => handler(sid, payload))
    }),
    [api, reveal]
  );
  const closeDebug = useCallback(() => {
    setDebugOpen(false);
    returnFocus();
  }, [returnFocus]);

  const settingsApi = useSettingsApi(api, reveal);

  /** What a typed query reaches past the commands (`lib/paletteFind.ts`). */
  const findFromPalette = useCallback(
    (query: string) => paletteFind(query, { api, session, openRouteOn, inspect, ...trips.opens }),
    [api, session, openRouteOn, inspect, trips.opens]
  );

  /** The console's own name index, per character. */
  const nameIndexes = useNameIndexes(api, sessions, views);

  /** Moving a character, and the question play may answer with. */
  const {
    sayRefusal,
    startMovingIn,
    stepBackIn,
    startMoving,
    stopMoving,
    startLoop,
    reverseLoop,
    runChosenLoop,
    runHunt,
    wandered,
    stay,
    walkOn
  } = useMovement({ api, session, profiles, returnFocus, say: noticeTo });
  const recentMenu = useRecentMenu({ api, openRouteOn, sayRefusal });
  const chooseLoop = useLoopJoin({ api, session, runChosenLoop, openToJoin, say: noticeTo });

  /** The loop builder, addressed at the shown character. */
  const { openBuilder, createHunt, builderApi } = useLoopBuilder({
    api,
    session,
    profiles,
    cards,
    characterName: character.name,
    search: searchRooms,
    loadMap,
    returnFocus,
    say: noticeTo
  });

  const handleInput = useCallback((id: SessionId, data: string) => api.input(id, data), [api]);

  /**
   * A line typed into the Talk card, sent exactly as typing it would send it.
   *
   * `api.input` and not a new channel: main assembles typed characters into
   * commands there, so this one call is what makes the tracker see the command,
   * a walk in progress stand down, the capture record it and a password get
   * redacted. A second route to the socket would be a second copy of all of
   * that, and copies drift.
   */
  const sayOnChannel = useCallback(
    (line: string) => api.input(activeRef.current, `${line}\r`),
    [api]
  );

  const handleResize = useCallback(
    (id: SessionId, next: TerminalSize) => {
      // The status rail describes the slate in front of you, so it follows the
      // shown character. Every session still reports its own geometry: they
      // share a box, so the numbers agree — but each says so for itself, which
      // is the shape that stays correct once panes can differ.
      if (id === activeRef.current) setSize(next);
      api.resize(id, next);
    },
    [api]
  );

  const toggleDebug = useCallback(() => setDebugOpen((open) => !open), []);

  /*
   * Each character's connection phase, memoised by **value**: the palette's
   * commands read only the phase out of `views`, and listing `views` itself
   * as a dependency rebuilt the whole command list — a few hundred objects —
   * on every state flush, which on a busy realm is several times a second.
   * The string changes when a phase does and not otherwise.
   */
  const phasesKey = useMemo<string>(
    () =>
      sessions.map((entry) => `${entry.id}=${views[entry.id]?.state.phase ?? ''}`).join('\u0000'),
    [sessions, views]
  );
  const phases = useMemo<Partial<Record<SessionId, ConnectionState['phase']>>>(() => {
    const out: Partial<Record<SessionId, ConnectionState['phase']>> = {};
    for (const pair of phasesKey.split('\u0000')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const phase = pair.slice(eq + 1) as ConnectionState['phase'] | '';
      if (phase !== '') out[pair.slice(0, eq) as SessionId] = phase;
    }
    return out;
  }, [phasesKey]);

  /*
   * The palette's commands (`lib/palette.ts`), rebuilt when something they
   * read moves and not otherwise.
   */
  // A boolean, so a walk's every step does not rebuild the list (todo 754).
  const moving = movementOf(view.walk, view.loop).moving;
  const paletteDeps: PaletteDeps = {
    api,
    session,
    sessions,
    profiles,
    servers: config.servers,
    phases,
    showTabs,
    connected,
    inGame,
    moving,
    loops,
    configPath,
    loggingEnabled: config.logging.enabled,
    railOpen,
    debugOpen,
    helpOpen,
    hud,
    setHud,
    timestamps: times,
    setTimestamps: setTimes,
    density,
    densityPreference: preference,
    cycleDensity: cycle,
    gameView: game.on,
    toggleGameView: game.toggle,
    theme: {
      theme,
      preference: themePreference,
      consolePreference,
      cycle: cycleTheme,
      choose: chooseTheme,
      chooseConsole
    },
    tabSide,
    setTabSide,
    panes,
    paneFlow,
    addPane,
    closePane,
    turnPanes,
    cards,
    autoLayout,
    widths,
    openSettings,
    manageServers,
    editGlobal,
    editDefaults,
    toggleConnection,
    connect: handleConnect,
    showSession,
    closeSession,
    openRoute,
    openBuilder,
    openSearch,
    toggleRail,
    toggleDebug,
    toggleHelp,
    toggleLoops,
    trips: trips.opens,
    reveal,
    terminal: activeTerminal,
    say: noticeTo
  };
  // Keyed on every field it is handed (`paletteKeys`), so none can be left out.
  const commands = useMemo<Command[]>(() => paletteCommands(paletteDeps), paletteKeys(paletteDeps));

  /**
   * The shelf at the top of the palette: what `internal.yaml` ships, as
   * deviated from by clicking a row's pin. Per client, like the density and
   * the theme — which commands somebody keeps to hand is a fact about the
   * person at the keyboard, not about a character.
   */
  const pins = usePinnedCommands(internalConfig.palette.pinned, commands);
  /*
   * Every button the toolbar has, in the order the kebab lists them. Fixed for
   * as long as the build is, so it is built once rather than per character —
   * `toolbarButtons` needs a character to say what each one *says*, and
   * nothing but the ids is needed to decide which are on the row.
   */
  const toolbarIds = useMemo(
    () => [...AUTOMATION_SWITCH_NAMES, ...TOOLBAR_ACTIONS] as string[],
    []
  );
  const toolbarPins = useToolbarPins(internalConfig.toolbar.pinned, toolbarIds);

  const covered =
    asked !== null ||
    flyout !== null ||
    browsing !== null ||
    paletteOpen ||
    loopsOpen ||
    settingsOpen ||
    helpOpen;
  useHotkeys([
    // Each chord is `CLIENT_KEYS`'s; the connection's are `useConnectionKeys`.
    { ...CLIENT_KEYS.palette, run: togglePalette },
    { ...CLIENT_KEYS.loops, run: toggleLoops },
    { ...CLIENT_KEYS.rail, run: toggleRail },
    { ...CLIENT_KEYS.latest, run: () => activeTerminal()?.jumpToLatest() },
    { ...CLIENT_KEYS.density, run: cycle },
    { ...CLIENT_KEYS.densityComma, run: cycle },
    { ...CLIENT_KEYS.theme, run: cycleTheme },
    { ...CLIENT_KEYS.search, run: toggleSearch },
    {
      ...CLIENT_KEYS.pane,
      run: () => {
        const next = sessions.find((entry) => !panes.includes(entry.id));
        if (next) addPane(next.id);
        else closePane();
      }
    },
    { ...CLIENT_KEYS.nextTab, run: () => stepSession(1) },
    { ...CLIENT_KEYS.previousTab, run: () => stepSession(-1) },
    { ...CLIENT_KEYS.route, run: toggleRoute },
    /*
     * Escape dismisses the topmost thing that is open, and is registered only
     * while something is. The palette handles its own Escape because it holds
     * focus; the rail cannot, because focus is still in the terminal — so it
     * needs a window-level key. Registering it conditionally is what keeps a
     * bare Escape reaching the game the rest of the time.
     *
     * A slide-out — the realm's answer about a name, or the Player flyout —
     * is topmost while it is open and owns its own Escape (it listens in
     * capture, like this does, and two capture listeners on one window both
     * fire) — so nothing here claims the key until it has gone. Otherwise
     * Escape closed the panel *and* the rail.
     */
    { ...CLIENT_KEYS.settings, run: openSettings },
    /*
     * A dialog that holds the caret owns its own Escape (`covered`), so a
     * window binding firing as well would put two surfaces away with one
     * keystroke: the failure `useHotkeys` records for the diagnostics rail
     * eating the Talk card's Escape. Below that, the topmost of the route
     * panel, the search bar, the rail (`railShown`: the game view hides it) and
     * the debug window takes it; its controls `keepFocus`, so unbound, Escape went to the realm.
     */
    ...(!covered && routeOpen ? [{ key: 'Escape', run: closeRoute }] : []),
    ...(!covered && searchOpen && !routeOpen ? [{ key: 'Escape', run: closeSearch }] : []),
    ...(!covered && railShown && !searchOpen && !routeOpen
      ? [{ key: 'Escape', run: toggleRail }]
      : []),
    ...(!covered && debugOpen && !railShown && !searchOpen && !routeOpen
      ? [{ key: 'Escape', run: closeDebug }]
      : [])
  ]);

  /** Everything a card reads, addressed to one character. */
  const { contextFor, suppliesBundle } = useCardContext({
    api,
    session,
    sessions,
    thresholds: config.ui.vitals,
    navigationVisible,
    size,
    meter,
    pressure,
    realmAt: loadedAt,
    flyout,
    nameIndexes,
    loops,
    toolbarPins,
    remotesFor,
    switchesFor,
    suppliesFor,
    profileNameFor,
    ask,
    forget,
    inspect,
    loadWearer,
    loadMap,
    lookupName,
    chooseOnMap,
    peekRoom,
    endPeek,
    goToRoom,
    runHunt,
    createHunt,
    builder: builderApi,
    openBuilder,
    startMoving,
    stopMoving,
    startLoop,
    reverseLoop,
    send: sayOnChannel,
    openLoops: toggleLoops,
    openAreaSearch: trips.opens.areaSearch,
    dial,
    hangUp,
    sayRefusal,
    startMovingIn,
    stepBackIn,
    selectPlayer,
    resetStats
  });
  /** The chrome every card wears, and a put-away card's handles. */
  const { chromeFor, pinnedChrome, grabCard, floatCard } = useCardChrome(
    cards,
    drag,
    returnFocus,
    theme
  );
  /** One card, wherever it is: the shown character's, or another's pinned float. */
  const { renderCard, pinnedFor } = useCardRenderers({
    cards,
    drag,
    railOpen,
    hudOpen,
    session,
    view,
    views,
    contextFor,
    chromeFor,
    pinnedChrome
  });

  // The Talk card in the game view's panel, with the panel's own close (todo 140).
  const renderTalk = useCallback(
    (onClose: () => void) =>
      cardElement(
        'conversation',
        contextFor(session, view, { cardId: 'conversation', onClose, returnFocus })
      ),
    [contextFor, session, view, returnFocus]
  );
  return (
    <div className="app" {...game.appProps}>
      <div
        className="workspace"
        data-dragging={drag.state?.live ? 'true' : undefined}
        data-rail={railVisible ? 'open' : 'closed'}
        // A splitter held: the pointer is the animation, and no transition
        // may lag behind it. A card's resize handle says so on the root.
        data-resizing={resizing ? 'true' : undefined}
        ref={workspaceRef}
        data-rail-side={railSide}
        data-tabs={showTabs ? tabSide : 'none'}
        style={workspaceStyle}
      >
        {/*
          Shown as soon as there are characters: with one it still names who is
          playing and holds their health, connection and close button. With
          none there is no rail, and the new-character form is open instead.
        */}
        <TabRail
          active={session}
          editable={editable}
          onClose={closeSession}
          onEdit={editCharacter}
          onEditGlobal={editGlobal}
          onNew={newCharacter}
          onOpen={api.loadProfile}
          onReorder={reorderSessions}
          onSelect={showSession}
          onStopRetrying={hangUp}
          onToggleConnection={toggleSessionConnection}
          profiles={profiles}
          restToFor={restToFor}
          returnFocus={returnFocus}
          sessions={showTabs ? sessions : NO_SESSIONS}
          side={tabSide}
          thresholds={config.ui.vitals}
          views={views}
        />

        {showTabs && tabSide !== 'top' && (
          <Splitter
            // Which way a drag grows the rail; `pane` is where the handle
            // goes. The two part company the moment the workspace mirrors.
            edge={tabSide === 'right' ? 'right' : 'left'}
            label={t('splitter.aria.tabRailWidth')}
            measure={measureTabs}
            onChange={widths.setTabs}
            onDragging={setResizing}
            onReset={resetTabs}
            pane="tabs"
            rangeFor={rangeForTabs}
          />
        )}

        <div className="terminal-stack">
          {/*
            Cards docked to the console rather than beside it.

            The placement a floating card cannot give you: it does not cover the
            game. Present only when something is in it — an empty strip is a
            band of chrome that costs rows for nothing — and horizontal, because
            rows are cheap and columns are not.

            Rendered even while a drag is in flight over an empty strip, so
            there is somewhere to drop.
          */}
          {(cards.above.length > 0 || drag.state?.live === true) && (
            <div
              className="dock dock-above"
              // An empty strip exists only while a drag is running, as somewhere
              // to drop. It *overlays* the console rather than taking rows: a
              // strip that appeared and vanished with every drag would resize
              // the terminal twice per gesture, and a terminal resize goes out
              // over NAWS and re-wraps a scrollback nobody asked to re-wrap.
              data-empty={cards.above.length === 0 ? 'true' : undefined}
            >
              <StripCards drag={drag.state} ids={cards.above} render={renderCard} strip="above" />
              {cards.above.length > 0 && (
                <Splitter
                  edge="top"
                  label={t('splitter.aria.topStripHeight')}
                  measure={measureAbove}
                  onChange={widths.setAbove}
                  onDragging={setResizing}
                  onReset={resetAbove}
                  rangeFor={rangeForAbove}
                />
              )}
            </div>
          )}
          {/*
            Every loaded character has a terminal and they all stay mounted: a
            tab switch shows a different one rather than rebuilding it, so the
            scrollback, the scroll position and the parser state survive. They
            share one box, so a hidden terminal still measures the geometry it
            would have if shown — which is what keeps NAWS honest.
          */}
          <div
            className="terminal-layers"
            data-flow={paneFlow}
            ref={layersRef}
            style={{ '--panes': panes.length } as CSSProperties}
          >
            {sessions.map((entry) => {
              const at = panes.indexOf(entry.id);
              return (
                <SessionTerminal
                  flow={paneFlow}
                  focused={at === paneAt}
                  fontStack={terminalFonts}
                  key={entry.id}
                  index={nameIndexes[entry.id] ?? null}
                  onChunk={noteChunk}
                  onFocusPane={focusPane}
                  onHandle={registerHandle}
                  onInput={handleInput}
                  onInspect={inspect}
                  onChooseRoom={chooseRoomNamed}
                  onSetting={openSetting}
                  recentMenu={recentMenu}
                  onResize={handleResize}
                  onSelectPlayer={selectPlayer}
                  onSelectGang={slideOuts.selectGang}
                  onSelectSlot={slideOuts.selectSlot}
                  onSearchResult={setSearchResult}
                  onSnapshot={applySnapshot}
                  // No pane: parked hidden in the focused one, measurable, out of the tab order.
                  pane={at >= 0 ? at : paneAt}
                  palette={game.paint(consolePalette)}
                  // The run banner over this pane: this character's, whichever pane is read.
                  run={views[entry.id]?.questRun ?? IDLE_QUEST_RUN}
                  // And how far through the walk the run is on, for the step
                  // count beside the node it is heading for (todo 03).
                  walk={views[entry.id]?.walk ?? null}
                  onStopRun={stopRunFor}
                  session={entry.id}
                  timestamps={times === 'on'}
                  settings={config.terminal}
                  shown={at >= 0}
                />
              );
            })}
            {/*
              What the client is doing, over the console rather than instead of
              it.

              **Inside the layers, and absolutely positioned.** The terminals
              stay mounted and laid out underneath: unmounting them would
              rebuild every xterm's scrollback and parser state, and *resizing*
              the console would go out over NAWS and re-wrap a scrollback
              nobody asked to re-wrap — the same answer the docked strips give.
              An absolutely positioned grid child creates no track, so the
              panes are not disturbed either. Against the layers rather than
              the whole stack, so it covers the console and not the toolbar
              docked above it: somebody reading a trace has not stopped wanting
              the switch that turns automation off.

              Addressed at the shown character, like every other diagnostic.
            */}
            {debugOpen && <DebugView api={debugApi} onClose={closeDebug} session={session} />}
          </div>
          <SearchBar
            onClose={closeSearch}
            onSearch={runSearch}
            open={searchOpen}
            result={searchResult}
          />
          {(cards.below.length > 0 || drag.state?.live === true) && (
            <div
              className="dock dock-below"
              data-empty={cards.below.length === 0 ? 'true' : undefined}
            >
              {cards.below.length > 0 && (
                <Splitter
                  edge="bottom"
                  label={t('splitter.aria.bottomStripHeight')}
                  measure={measureBelow}
                  onChange={widths.setBelow}
                  onDragging={setResizing}
                  onReset={resetBelow}
                  rangeFor={rangeForBelow}
                />
              )}
              <StripCards drag={drag.state} ids={cards.below} render={renderCard} strip="below" />
            </div>
          )}
        </div>

        {railVisible && (
          <Splitter
            // The console's edge, beside the card rail: a drag moves whole
            // columns, eighty to a hundred and twenty a pane.
            edge={railSide === 'right' ? 'left' : 'right'}
            label={t('splitter.aria.consoleWidth', CONSOLE_RANGE)}
            measure={measureConsole}
            onChange={setConsole}
            onDragging={setResizing}
            onReset={resetConsole}
            pane="rail"
            rangeFor={rangeForConsole}
          />
        )}

        {railVisible && (
          <div className="rail">
            {/*
              Adding one back where its gap is, and the view switch (`CardRailHead`).
            */}
            <CardRailHead
              autoLayout={autoLayout}
              away={cards.away}
              dragging={drag.state?.live === true}
              onAdd={cards.show}
              onFloat={floatCard}
              // A row is a handle as well as a button: dragged onto the
              // console it floats there, into the rail it lands there.
              onGrab={grabCard}
              onGameView={game.toggle}
              showLogo={config.ui.showLogo}
            />

            {/*
              Where this character put them, on the grid. One list, rendered by
              one function, so a card dragged across the rail is the same card,
              and a new card added to the vocabulary needs no entry here.
            */}
            <RailGrid drag={drag.state} grid={railGrid} layout={cards} render={renderCard} />
          </div>
        )}

        {/*
          Cards lifted off the rail and left over the console.

          Last in the workspace so they paint above the slate, and inert as a
          layer — only the cards themselves take the pointer, or an empty float
          layer would swallow every click meant for the game.
        */}
        <FloatLayer boxRef={workspaceRef} layout={cards} render={renderCard} />
        {sessions
          .filter((entry) => entry.id !== session)
          .map((entry) => (
            <PinnedFloats
              boxRef={workspaceRef}
              key={entry.id}
              onStreamFloat={noteStreamFloat}
              render={pinnedFor(entry.id)}
              sid={entry.id}
            />
          ))}

        {/* What is in hand, and where releasing it beside another float puts it. */}
        <DragMarks
          floating={drag.state ? cards.floatOf(drag.state.id) !== undefined : false}
          state={drag.state}
        />
      </div>

      {game.on && (
        <GameView
          api={api}
          game={game}
          config={config}
          configKnown={loadedAt > 0}
          openRouteOn={openRouteOn}
          profile={profiles.find((one) => one.id === session) ?? null}
          renderTalk={renderTalk}
          say={noticeTo}
          session={session}
          stepBack={stepBackIn}
          view={view}
        />
      )}

      <SlideOuts
        api={api}
        ask={ask}
        character={character}
        chooseOnMap={chooseOnMap}
        loadRoomBrief={loadRoomBrief}
        lookup={lookupName}
        remotesFor={remotesFor}
        returnFocus={returnFocus}
        say={noticeTo}
        slot={slideOuts}
        supplies={suppliesBundle(session)}
        views={views}
      />

      <StatusRail
        action={action}
        meter={meter}
        density={density}
        densityPreference={preference}
        onCycleDensity={cycle}
        onOpenPalette={openPalette}
        onOpenHelp={toggleHelp}
        onToggleConnection={toggleConnection}
        pressure={pressure}
        size={size}
        state={state}
      />

      <CommandPalette
        commands={commands}
        find={findFromPalette}
        onClose={closePalette}
        onTogglePin={pins.toggle}
        open={paletteOpen}
        pinned={pins.pinned}
      />

      {/*
        Find a room, read the way there, walk it. Beside the palette and the
        loops modal rather than inside the console column, because it floats
        over the console on the palette's own scrim now: a strip docked under
        the terminal took rows from it, and taking rows resizes the terminal.
      */}
      <RoutePanel
        destination={routeTarget}
        /* What the shared window draws on top of the realm here, as the Map
           card draws it: where the realm's find log says something was turned
           up. The loud ring on this picture is the destination's, so no
           `you` — see the panel. */
        finds={foundRooms}
        onClose={closeRoute}
        onLoadMap={loadMap}
        /* A room on the plan pointed at opens the same panel the map opens,
           from the same query — so *four lairs on the way* can be read one
           room at a time rather than walked into. */
        onPeek={peekPlanned}
        onPeekEnd={endPeek}
        onRoute={routeTo}
        onSearch={searchRooms}
        onCollectThenWalk={collectThenWalk}
        joining={routeJoining}
        onWalk={walkRoute}
        open={routeOpen}
        search={routeSearch}
      />

      {/* Every loop the client knows; a pick shows the way to it first (`useLoopJoin`). */}
      <LoopsModal
        characterName={character.name ?? session}
        here={loopHere}
        loading={loopsLoading}
        loops={loopChoices}
        onChoose={chooseLoop}
        onClose={closeLoops}
        open={loopsOpen}
        realmName={profiles.find((profile) => profile.id === session)?.serverName ?? ''}
      />

      {/*
        The client's files, listed in the window, where the host has no file
        manager to open them in — and the realm picker in web mode, which
        chooses from the client's disk rather than the viewer's.
      */}
      {browsing !== null && (
        <HomeBrowser onClose={closeBrowser} onPick={browsing.pick} start={browsing.start} />
      )}
      {helpOpen && <HelpScreen onClose={closeHelp} />}
      {/*
        Play asked back: the character has wandered a long way from what it was
        walking. The same play is pressed again, `confirmed`, or the movement
        is left stopped exactly where it was.
      */}
      <MovementPrompt
        asked={
          wandered === null
            ? null
            : { kind: wandered.kind, name: wandered.name, steps: wandered.steps }
        }
        characterName={wandered === null ? '' : profileNameFor(wandered.session)}
        onStay={stay}
        onWalk={walkOn}
      />
      <ResetGate api={api} profiles={profiles} returnFocus={returnFocus} />
      <LowLivesPrompt
        ask={livesAsked?.payload ?? null}
        characterName={livesAsked === null ? '' : profileNameFor(livesAsked.session)}
        onAnswer={answerLowLives}
      />
      <TripDialogs api={api} trips={trips} profiles={profiles} />
      <SettingsScreen
        {...settingsApi}
        sheetFor={sheetFor}
        figuresFor={figuresFor}
        palette={consolePalette}
        onClose={closeSettings}
        open={settingsOpen}
        openAt={settingsAt}
        required={mustMakeCharacter}
      />
    </div>
  );
}
