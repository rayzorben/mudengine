import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react';

import CommandPalette, { type Command } from './components/CommandPalette';
import SearchBar from './components/SearchBar';
import RoutePanel from './components/RoutePanel';
import CardPicker from './components/CardPicker';
import FloatLayer from './components/FloatLayer';
import PinnedFloats from './components/PinnedFloats';
import SettingsScreen from './components/SettingsScreen';
import StandbyCard from './components/StandbyCard';
import SessionTerminal from './components/SessionTerminal';
import SlideOuts from './components/SlideOuts';
import TabRail, { type RailSide } from './components/TabRail';

import DebugView from './components/DebugView';
import type { DebugRecord } from '@shared/debug';
import StatusRail from './components/StatusRail';
import LoopsModal from './components/LoopsModal';
import HomeBrowser from './components/HomeBrowser';
import { TOOLBAR_ACTIONS } from './lib/toolbar';
import { useToolbarPins } from './hooks/useToolbarPins';
import { type TerminalHandle } from './components/TerminalView';
import { useConfig } from './hooks/useConfig';
import { useConnection } from './hooks/useConnection';
import { useDiagnosticFeeds } from './hooks/useDiagnosticFeeds';
import { useNameIndexes } from './hooks/useNameIndexes';
import { useNavigationVisible } from './hooks/useNavigationVisible';
import {
  measureAbove,
  measureBelow,
  measureRail,
  measureTabs,
  usePaneRanges
} from './hooks/usePaneRanges';
import { useCardLayout } from './hooks/useCardLayout';
import { cardLabel, type Lane } from './lib/cards';
import { useCardChrome } from './hooks/useCardChrome';
import { useCardContext } from './hooks/useCardContext';
import { useCardRenderers } from './hooks/useCardRenderers';
import { usePaneWidths } from './hooks/usePaneWidths';
import { useLoopBuilder } from './hooks/useLoopBuilder';
import { useLoopsModal } from './hooks/useLoopsModal';
import { useMovement } from './hooks/useMovement';
import { usePanes } from './hooks/usePanes';
import { useProfileReaders } from './hooks/useProfileReaders';
import { useRoutePanel } from './hooks/useRoutePanel';
import { useSearchBar } from './hooks/useSearchBar';
import { useSettingsScreen } from './hooks/useSettingsScreen';
import { useRouteOpeners } from './hooks/useRouteOpeners';
import { useShownRealm } from './hooks/useShownRealm';
import { useSlideOuts } from './hooks/useSlideOuts';
import { EMPTY_VIEW, useSessionViews } from './hooks/useSessionViews';
import { usePinnedCommands } from './hooks/usePins';
import { Splitter } from './components/Splitter';
import { useCardDrag } from './hooks/useCardDrag';
import { useCommandPalette } from './hooks/useCommandPalette';
import { useHomeBrowser } from './hooks/useHomeBrowser';
import { useCardResize } from './hooks/useCardResize';
import { reordered } from './lib/reorder';
import { useDensity } from './hooks/useDensity';
import { useAlerts } from './hooks/useAlerts';
import { useDesktopAlerts } from './hooks/useDesktopAlerts';
import { useHotkeys } from './hooks/useHotkeys';
import { useOverridablePreference } from './hooks/usePreference';
import { useTheme } from './hooks/useTheme';
import { useStreamPressure } from './hooks/useStreamPressure';
import { t } from './lib/i18n';
import { paletteCommands, paletteKeys, type PaletteDeps } from './lib/palette';
import { paletteFind } from './lib/paletteFind';
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
import type { Addressed, ResetNotice } from '@shared/ipc';
import MovementPrompt from './components/MovementPrompt';
import ResetPrompt from './components/ResetPrompt';
import type { GlobalDraft, ProfileDraft, ServerDraft } from '@shared/drafts';
import { type ProfileSummary, type SessionId, type SessionSummary } from '@shared/ipc';
import type { ConnectionState, TerminalActionName, TerminalSize } from '@shared/types';
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
  } = usePanes(sessions, size.cols, noticeTo);

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
  /**
   * The client thinks the character in the realm is not the one its records are
   * about, and is asking.
   *
   * Addressed, and held in `App` rather than remembered anywhere: main asks
   * once per session (`SessionManager.watchForReset`), so a dialog that
   * survived a reload would be one nobody could answer. Null is *nothing
   * noticed*.
   */
  const [resetAsked, setResetAsked] = useState<Addressed<ResetNotice> | null>(null);

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
   * What this character's percentages are percentages *of*, for the settings
   * screen's fields.
   *
   * Read off the live view rather than carried on the settings snapshot: a
   * maximum comes from the stat sheet and moves when the character levels, and
   * a figure baked into a snapshot taken when the dialog opened would be
   * confidently stale. Both are null for a character not in the realm, which is
   * the answer `figureOf` draws as nothing at all.
   */
  const maximaFor = useCallback(
    (id: SessionId): { hpMax: number | null; manaMax: number | null } => {
      const vitals = views[id]?.character.vitals;
      return { hpMax: vitals?.hpMax ?? null, manaMax: vitals?.manaMax ?? null };
    },
    [views]
  );
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

  /**
   * Same precedence as density and theme: the palette toggle is remembered, and
   * an edit to `ui.showHud` in the options file overrides the memory.
   */
  const [hudPreference, setHudPreference] = useOverridablePreference(
    'mudengine.hud',
    config.ui.showHud ? 'on' : 'off',
    (value): value is 'on' | 'off' => value === 'on' || value === 'off'
  );
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
   * The rails' widths, dragged and remembered per client. The range a drag may
   * move within is computed when the gesture starts, from the console as laid
   * out and the terminal's measured cell width — so the floor is eighty
   * *measured* columns, never a pixel constant (docs/ui-design.md §3.8).
   */
  const widths = usePaneWidths();
  const [resizing, setResizing] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const drag = useCardDrag(cards, workspaceRef);

  // The corner grip on a rail card, the same shape as the float's: one axis,
  // stored as a fraction of the rail.
  const resize = useCardResize(cards);

  /** What each splitter measures, and the range a drag of it may move within. */
  const {
    rangeForTabs,
    rangeForRail,
    rangeForAbove,
    rangeForBelow,
    resetTabs,
    resetAbove,
    resetBelow
  } = usePaneRanges(layersRef, size, widths);

  const { pressure, meter, record, reset } = useStreamPressure();

  /**
   * One line for what the engine is doing, newest concern first.
   *
   * A walk in progress outranks a queue depth: the walk is a plan someone
   * started, the queue is bookkeeping. Nothing at all when nothing is
   * happening — an always-present segment is chrome, not a state.
   *
   * "standing down" is deliberately **not** shown here any more. The typing
   * hold made it true on every keystroke, so the bar announced the player's
   * own fingers back at them — a state they already know, phrased as though
   * the engine had decided something. What is queued *behind* the hold is
   * engine state worth a segment; the hold itself is not.
   */
  const action = useMemo(() => {
    if (walk.status === 'walking') {
      const step = walk.step?.command ?? '';
      const progress = t('statusRail.action.walking', { done: walk.done, total: walk.total });
      return step ? `${progress} · ${step}` : progress;
    }
    const next = automation.queue.pending[0];
    if (next) {
      return t('statusRail.action.queued', {
        depth: automation.queue.depth,
        command: next.command
      });
    }
    return null;
  }, [walk, automation.queue]);

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
  const pendingNotices = useRef<string[]>([]);

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
   * Deferred a frame so it lands after React has committed whatever closed. A
   * command that deliberately parks focus elsewhere opts out with `movesFocus`
   * rather than racing this.
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
  const returnFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      if (document.activeElement?.closest('[role="dialog"]')) return;
      activeTerminal()?.focus();
    });
  }, [activeTerminal]);

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
    close: closeRoute,
    openOn: openRouteOn,
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
   * Here rather than inside the panel because the panel belongs to the
   * character on screen and nothing else; a *card* computes its own, addressed
   * at the character it was drawn for, which is the rule every other world
   * fact in this file follows.
   */
  const foundRooms = useMemo(() => [...roomsWithFinds(view.finds)], [view.finds]);

  /** The panels that hang off a name, one at a time. */
  const slideOuts = useSlideOuts(session, chooseOnMap);
  const { asked, flyout, inspect, selectPlayer, selectGang, peekRoom, peekPlanned, endPeek } =
    slideOuts;

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

  /** Engine messages arriving before there is a terminal to print them into. */
  useEffect(() => {
    if (pendingNotices.current.length === 0) return;
    const handle = terminals.current.get(session);
    if (!handle) return;
    for (const message of pendingNotices.current) handle.notice(message);
    pendingNotices.current = [];
  }, [session, handleTick]);

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
   * What arrives about the client and its roster rather than about a
   * character's facts, which `useSessionViews` keeps.
   */
  useEffect(() => {
    const off = [
      // Not folded into a view: it is a question about a character rather than
      // a fact about one, and it is answered once.
      api.onCharacterReset((message) => setResetAsked(message)),
      // A notice with no session is about the client rather than a character —
      // an options file that failed to parse belongs to nobody — and still has
      // to be seen, so it is shown wherever the player is looking.
      api.onNotice(({ session: from, message }) => {
        const handle = terminals.current.get(from ?? activeRef.current);
        if (handle) handle.notice(message);
        else pendingNotices.current.push(message);
      }),
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
  const hudOpen = hudPreference === 'on';
  /**
   * The HUD appears on its own, without the diagnostics rail.
   *
   * Vitals and Room are what the player reads while playing; putting them
   * behind a toggle labelled "diagnostics" meant they were never seen. The rail
   * is therefore present whenever there is *either* HUD content or diagnostics
   * to show, and each half decides for itself.
   */
  const railVisible = hudOpen || railOpen;

  const connected = state.phase === 'connected';
  const busy = state.phase === 'connecting' || state.phase === 'closing';

  /** Dialling and hanging up, the shown character's and any tab's own. */
  const { dial, hangUp, handleConnect, toggleSessionConnection, toggleConnection } = useConnection({
    api,
    session,
    shown: activeRef,
    sessions,
    views,
    patchView,
    connected,
    reset
  });

  /*
   * The alerts worth saying outside the window, for a player who has gone and
   * done something else. Read from what actually landed in each character's
   * log (`views`) rather than raised where the notices are folded in: that
   * happens inside a state updater, and a notification has to happen exactly
   * once.
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
  const sayAboutAlerts = useCallback(
    (message: string) => {
      const handle = activeTerminal();
      if (handle) handle.notice(message);
      else pendingNotices.current.push(message);
    },
    [activeTerminal]
  );
  useDesktopAlerts({
    subjects: views,
    // The player's own rows, and the only thing that decides what is raised
    // outside the window: a row marked `notify`, and its own `whileFocused`.
    rules: config.ui.alerts.rules,
    onOpen: openAlerted,
    onRefused: sayAboutAlerts
  });

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
      subscribe: (handler: (sid: SessionId, record: DebugRecord) => void) =>
        api.onDebug(({ session: sid, payload }) => handler(sid, payload))
    }),
    [api, reveal]
  );
  const closeDebug = useCallback(() => {
    setDebugOpen(false);
    returnFocus();
  }, [returnFocus]);

  /**
   * Stable callbacks for the settings screen.
   *
   * Inline arrows would be a new function on every render, and a child that
   * keys an effect on one then runs it on every render — which is how a refused
   * save came to flash and vanish before anybody could read it.
   */
  const settingsApi = useMemo(
    () => ({
      load: () => api.settingsSnapshot(),
      saveProfile: (id: string, draft: ProfileDraft) => api.saveProfile(id, draft),
      deleteProfile: (id: string) => api.deleteProfile(id),
      saveServer: (previous: string | null, draft: ServerDraft) => api.saveServer(previous, draft),
      deleteServer: (name: string) => api.deleteServer(name),
      saveGlobal: (draft: GlobalDraft) => api.saveGlobal(draft),
      revealConfig: () => reveal(() => api.revealConfig()),
      revealProfiles: () => reveal(() => api.revealProfiles()),
      chooseRealm: () => api.chooseRealm(),
      // The shelf of shipped loops, for the Movement tab. Asked for when
      // that picker opens rather than with the snapshot: four hundred
      // loops, and most visits to that screen are about a password.
      loadLoops: () => api.loopCatalogue(),
      // And the trainers that will take a character, for the Train tab's
      // picker. Addressed: the bands are per level and per class.
      loadTrainers: (session: SessionId) => api.trainers(session),
      loadBanks: (session: SessionId) => api.banks(session),
      // And what the realm says would serve each condition, for the potion
      // rule list's suggestions.
      loadServing: (session: SessionId) => api.itemsServing(session),
      // And the realm's own rules of the same kind, for the rows under it.
      loadWards: (session: SessionId) => api.wards(session),
      // And the monsters the realm names, for the priority list's picker.
      loadMobNames: (session: SessionId) => api.mobNames(session)
    }),
    [api, reveal]
  );

  /** What a typed query reaches past the commands (`lib/paletteFind.ts`). */
  const findFromPalette = useCallback(
    (query: string) => paletteFind(query, { api, session, openRouteOn, inspect }),
    [api, session, openRouteOn, inspect]
  );

  /*
   * A console button main runs, addressed to the character whose terminal it
   * was pressed in — not to the focused pane, which may be a different one.
   *
   * Nothing crosses but the action's name. The figure a `Deposit All` needs is
   * not knowable here, and was not knowable in main either at the moment the
   * line was drawn, which is the whole reason this is an action rather than a
   * list of commands (`TerminalIntentAction`).
   */
  const actInConsole = useCallback((sid: SessionId, action: TerminalActionName) => {
    void api.terminalAct(sid, action);
  }, []);

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
    skipLoop,
    reverseLoop,
    runChosenLoop,
    runHunt,
    wandered,
    stay,
    walkOn
  } = useMovement({ api, session, profiles, returnFocus, say: noticeTo });

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
    hud: hudPreference,
    setHud: setHudPreference,
    density,
    densityPreference: preference,
    cycleDensity: cycle,
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
    widths: {
      rail: widths.rail,
      tabs: widths.tabs,
      above: widths.above,
      below: widths.below,
      reset: widths.reset
    },
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
    toggleLoops,
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

  useHotkeys([
    { key: 'k', mod: true, run: togglePalette },
    /*
     * The Loops modal. `Ctrl/Cmd L` was free in this table — jump-to-latest is
     * `Ctrl/Cmd Shift L` — and the realm's own command list (docs/greatermud)
     * claims no control character here, so nothing is being taken from the
     * game. It is a chord, so a text field in the chrome keeps its own keys.
     */
    { key: 'l', mod: true, run: toggleLoops },
    { key: 'Enter', mod: true, run: toggleConnection },
    { key: 'd', mod: true, shift: true, run: toggleRail },
    { key: 'l', mod: true, shift: true, run: () => activeTerminal()?.jumpToLatest() },
    { key: '<', mod: true, shift: true, run: cycle },
    { key: ',', mod: true, shift: true, run: cycle },
    { key: 't', mod: true, shift: true, run: cycleTheme },
    { key: 'f', mod: true, run: toggleSearch },
    // Browser muscle memory, and the game has no use for either chord.
    {
      key: '\\',
      mod: true,
      run: () => {
        const next = sessions.find((entry) => !panes.includes(entry.id));
        if (next) addPane(next.id);
        else closePane();
      }
    },
    { key: 'Tab', mod: true, run: () => stepSession(1) },
    { key: 'Tab', mod: true, shift: true, run: () => stepSession(-1) },
    { key: 'g', mod: true, run: toggleRoute },
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
    { key: ',', mod: true, run: openSettings },
    /*
     * `loopsOpen` joins the palette and the settings screen in every guard
     * below: the modal holds the caret and owns its own Escape, so a window
     * binding firing as well would put two surfaces away with one keystroke —
     * the failure `useHotkeys` records for the diagnostics rail eating the
     * Talk card's Escape.
     */
    ...(asked === null &&
    flyout === null &&
    browsing === null &&
    routeOpen &&
    !paletteOpen &&
    !loopsOpen &&
    !settingsOpen
      ? [{ key: 'Escape', run: closeRoute }]
      : []),
    ...(asked === null &&
    flyout === null &&
    browsing === null &&
    searchOpen &&
    !paletteOpen &&
    !loopsOpen &&
    !routeOpen &&
    !settingsOpen
      ? [{ key: 'Escape', run: closeSearch }]
      : []),
    ...(asked === null &&
    flyout === null &&
    browsing === null &&
    railOpen &&
    !paletteOpen &&
    !loopsOpen &&
    !searchOpen &&
    !routeOpen &&
    !settingsOpen
      ? [{ key: 'Escape', run: toggleRail }]
      : []),
    /*
     * And the debug window, which is the one surface here that *covers* the
     * console. Every control in it uses `keepFocus`, so the caret is still in
     * the terminal — without this, Escape pressed to dismiss a full-console
     * overlay goes to the realm instead, with the console covered so nobody
     * can see what it did. Last in the chain, like the rail it is modelled on.
     */
    ...(asked === null &&
    flyout === null &&
    browsing === null &&
    debugOpen &&
    !paletteOpen &&
    !loopsOpen &&
    !searchOpen &&
    !routeOpen &&
    !railOpen &&
    !settingsOpen
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
    skipLoop,
    reverseLoop,
    send: sayOnChannel,
    openLoops: toggleLoops,
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
    resize,
    returnFocus,
    theme
  );
  /** One card, wherever it is: the shown character's, or another's pinned float. */
  const { renderCard, pinnedFor } = useCardRenderers({
    cards,
    drag,
    railOpen,
    hudOpen,
    inGame,
    session,
    view,
    views,
    contextFor,
    chromeFor,
    pinnedChrome
  });

  /*
   * Where a dragged card would land on the rail, or null if it would not.
   *
   * Drawn as a gap *between* cards, because the whole reason the indicator
   * exists is that a drop landing somewhere the player was not shown is a drop
   * they have to undo.
   */
  const dropIn = (which: Lane): number | null =>
    drag.state?.live && drag.state.target.where === 'lane' && drag.state.target.lane === which
      ? drag.state.target.index
      : null;

  /**
   * One lane of cards, with a gap the dragged card's own size opened where a
   * drop would land.
   *
   * A gap rather than a line, so the cards below it move out of the way and
   * the card is *felt* to move before it is dropped — a line said where, and
   * nothing else on the rail changed until the pointer was released. It is
   * not drawn where the drop would change nothing: there the dimmed card
   * itself is the gap, and a second box beside it would read as two places
   * for one card. `reordered` is the same arithmetic the drop commits with,
   * so the two cannot disagree about which drops are no move.
   *
   * The rail and the two docked strips render from the same function: they
   * differ only in which way they run, and two copies of this would drift the
   * moment one of them gained a case.
   */
  const lane = (which: Lane): ReactNode => {
    const at = dropIn(which);
    const ids = cards[which];
    const held = drag.state;
    const noMove =
      at !== null && held !== null && ids.includes(held.id) && reordered(ids, held.id, at) === ids;
    const slot =
      at !== null && held !== null && !noMove ? (
        <div
          className="rail-slot"
          data-shape={held.shape}
          style={
            held.shape === 'card'
              ? ({
                  '--slot-w': `${held.size.w}px`,
                  '--slot-h': `${held.size.h}px`
                } as React.CSSProperties)
              : undefined
          }
        />
      ) : null;
    return (
      <>
        {ids.map((id, index) => {
          const card = renderCard(id);
          if (card === null) return null;
          return (
            <Fragment key={id}>
              {at === index && slot}
              {card}
            </Fragment>
          );
        })}
        {/* The gap at the very end, which no card precedes. */}
        {at !== null && at >= ids.length && slot}
      </>
    );
  };

  return (
    <div className="app">
      <div
        className="workspace"
        data-dragging={drag.state?.live ? 'true' : undefined}
        data-rail={railVisible ? 'open' : 'closed'}
        // A splitter or a card's corner grip: either way the pointer is the
        // animation, and no transition may lag behind it.
        data-resizing={resizing || resize.active !== null ? 'true' : undefined}
        ref={workspaceRef}
        data-rail-side={railSide}
        data-tabs={showTabs ? tabSide : 'none'}
        style={widths.style as React.CSSProperties}
      >
        {/*
          Shown as soon as there are characters, not only when there is a choice
          between them. With one it is still the thing that names who you are
          playing and reports their health -- and it is where the connection
          state and the close affordance live now that the command strip is
          gone. With no characters there is no rail, because there is nothing to
          say — and no session either: the new-character form is open instead.
        */}
        <TabRail
          active={session}
          editable={editable}
          onClose={closeSession}
          onEdit={editCharacter}
          onEditGlobal={editGlobal}
          onNew={newCharacter}
          onReorder={reorderSessions}
          onSelect={showSession}
          onToggleConnection={toggleSessionConnection}
          restToFor={restToFor}
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
              {lane('above')}
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
                  onAct={actInConsole}
                  onResize={handleResize}
                  onSelectPlayer={selectPlayer}
                  onSelectGang={selectGang}
                  onSearchResult={setSearchResult}
                  onSnapshot={applySnapshot}
                  // A character with no pane parks in the focused one, hidden:
                  // laid out, so it stays measurable, and out of the tab order.
                  pane={at >= 0 ? at : paneAt}
                  palette={consolePalette}
                  // The run banner over this pane: the push main addresses at
                  // this character, whichever pane is being read.
                  run={views[entry.id]?.questRun ?? IDLE_QUEST_RUN}
                  // And how far through the walk the run is on, for the step
                  // count beside the node it is heading for (todo 03).
                  walk={views[entry.id]?.walk ?? null}
                  onStopRun={stopRunFor}
                  session={entry.id}
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
            {debugOpen && (
              <DebugView
                load={debugApi.load}
                onClose={closeDebug}
                reveal={debugApi.reveal}
                save={debugApi.save}
                session={session}
                subscribe={debugApi.subscribe}
              />
            )}
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
              {lane('below')}
            </div>
          )}
        </div>

        {railVisible && (
          <Splitter
            edge={railSide}
            label={t('splitter.aria.cardRailWidth')}
            measure={measureRail}
            onChange={widths.setRail}
            onDragging={setResizing}
            onReset={widths.reset}
            pane="rail"
            rangeFor={rangeForRail}
          />
        )}
        {railVisible && (
          <div className="rail">
            {/*
              Adding one back, at the top of the rail where the gap it leaves
              is. Only lists what is actually put away, so it is a control that
              disappears when there is nothing to do with it.
            */}
            {cards.away.length > 0 && (
              <CardPicker
                cards={cards.away}
                dragging={drag.state?.live === true}
                onAdd={cards.show}
                onFloat={floatCard}
                // A row is a handle as well as a button: dragged onto the
                // console it floats there, into the rail it lands there.
                onGrab={grabCard}
              />
            )}

            {/*
              The rail says what it is waiting for rather than emptying out.
              A blank column beside a live one reads as damage, not as offline.
            */}
            {hudOpen && !inGame && <StandbyCard character={character} state={state} />}

            {/*
              In the order this character arranged them. One list, rendered by
              one function, so a card dragged from third to first is the same
              card — and a new card added to the vocabulary needs no entry here.
            */}
            {lane('rail')}
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

        {/*
          What is being dragged, following the pointer, in its own shape.

          A ghost rather than the card itself: moving the real node out of the
          rail would collapse the gap it leaves and shift every measurement the
          drop target is computed from, so the indicator would point somewhere
          the card is no longer going. The ghost is the size of what was
          picked up — the card's box, or a put-away card's chip — and held
          where the pointer took hold of it, so the card is felt to move
          rather than a label to appear. A card already floating needs none:
          it follows the pointer itself.
        */}
        {/*
          Where a released card would land, beside the one it is being lined up
          with: the landing box itself, drawn where the card will be and at the
          size it will take. A bar along the seam would say which edge and not
          what happens to the card, and the whole point of the gesture is that
          the card takes its neighbour's measurement across that edge.
        */}
        {drag.state?.live && drag.state.target.where === 'snap' && (
          <div
            className="snap-indicator"
            /* Which card, and which of its edges — the two facts the box's own
               geometry does not state outright, for a person inspecting the
               window and for the check that drives the gesture. */
            data-side={drag.state.target.side}
            data-snap-to={drag.state.target.to}
            style={{
              left: drag.state.target.box.x,
              top: drag.state.target.box.y,
              width: drag.state.target.box.w,
              height: drag.state.target.box.h
            }}
          />
        )}

        {drag.state?.live && !cards.floatOf(drag.state.id) && (
          <div
            className="drag-ghost"
            data-shape={drag.state.shape}
            style={{
              left: drag.state.x - drag.state.grab.dx,
              top: drag.state.y - drag.state.grab.dy,
              ...(drag.state.size.w > 0 ? { width: drag.state.size.w } : {}),
              ...(drag.state.size.h > 0 ? { height: drag.state.size.h } : {})
            }}
          >
            {cardLabel(drag.state.id)}
          </div>
        )}
      </div>

      <SlideOuts
        api={api}
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
        busy={busy}
        meter={meter}
        density={density}
        densityPreference={preference}
        onCycleDensity={cycle}
        onOpenPalette={openPalette}
        onToggleConnection={toggleConnection}
        pressure={pressure}
        showLogo={config.ui.showLogo}
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
        onWalk={walkRoute}
        open={routeOpen}
        search={routeSearch}
      />

      {/*
        Every loop the client knows, from anywhere in the game. The Navigation
        card's Loop face drives the loop that is running; this is where one is
        found.
      */}
      <LoopsModal
        characterName={character.name ?? session}
        here={loopHere}
        loading={loopsLoading}
        loops={loopChoices}
        onChoose={runChosenLoop}
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

      {/*
        The way in for somebody who has not read the source. Everything it does
        not cover — automation rules, per-character UI — stays in the YAML,
        which is what YAML is good at, and the screen says where the files are.
      */}
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
        characterName={
          profiles.find((profile) => profile.id === wandered?.session)?.name ??
          wandered?.session ??
          ''
        }
        onStay={stay}
        onWalk={walkOn}
      />
      <ResetPrompt
        characterName={
          profiles.find((profile) => profile.id === resetAsked?.session)?.name ??
          resetAsked?.session ??
          ''
        }
        notice={resetAsked?.payload ?? null}
        onForget={() => {
          const asked = resetAsked;
          setResetAsked(null);
          if (asked) void api.forgetCharacter(asked.session);
          returnFocus();
        }}
        onKeep={() => {
          setResetAsked(null);
          returnFocus();
        }}
      />
      <SettingsScreen
        deleteProfile={settingsApi.deleteProfile}
        deleteServer={settingsApi.deleteServer}
        load={settingsApi.load}
        maximaFor={maximaFor}
        figuresFor={figuresFor}
        palette={consolePalette}
        onClose={closeSettings}
        open={settingsOpen}
        openAt={settingsAt}
        required={mustMakeCharacter}
        revealConfig={settingsApi.revealConfig}
        chooseRealm={settingsApi.chooseRealm}
        loadLoops={settingsApi.loadLoops}
        loadTrainers={settingsApi.loadTrainers}
        loadBanks={settingsApi.loadBanks}
        loadServing={settingsApi.loadServing}
        loadWards={settingsApi.loadWards}
        loadMobNames={settingsApi.loadMobNames}
        revealProfiles={settingsApi.revealProfiles}
        saveProfile={settingsApi.saveProfile}
        saveGlobal={settingsApi.saveGlobal}
        saveServer={settingsApi.saveServer}
      />
    </div>
  );
}
