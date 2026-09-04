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
import AutomationCard from './components/AutomationCard';
import LinkCard from './components/LinkCard';
import MapCard from './components/MapCard';
import SearchBar, { type SearchResult } from './components/SearchBar';
import RoomCard from './components/RoomCard';
import RoutePanel from './components/RoutePanel';
import CardPicker from './components/CardPicker';
import FloatLayer from './components/FloatLayer';
import NotificationsCard from './components/NotificationsCard';
import CombatCard from './components/CombatCard';
import PartyCard from './components/PartyCard';
import RealmCard from './components/RealmCard';
import PlayerFlyout, { type PlayerAsked } from './components/PlayerFlyout';
import GangFlyout, { type GangAsked } from './components/GangFlyout';
import { canRestore, type GearAction } from '@shared/gear';
import { knownGangs } from './lib/gangs';
import { ago, knownPlayerNames, presentPlayerNames } from './lib/players';
import { NameIndex } from './lib/names';
import PlayersCard from './components/PlayersCard';
import GangCard from './components/GangCard';
import SettingsScreen, {
  SETTINGS_DEFAULTS,
  SETTINGS_GLOBAL,
  SETTINGS_MANAGE_SERVERS,
  SETTINGS_NEW_CHARACTER
} from './components/SettingsScreen';
import StandbyCard from './components/StandbyCard';
import StatsCard from './components/StatsCard';
import ConversationCard from './components/ConversationCard';
import BanksCard from './components/BanksCard';
import InventoryCard from './components/InventoryCard';
import SessionCard from './components/SessionCard';
import SessionTerminal from './components/SessionTerminal';
import ReferenceCard from './components/ReferenceCard';
import ReferencePopover, { type Asked } from './components/ReferencePopover';
import TabRail, { type RailSide } from './components/TabRail';

/** How the panes divide the slate. */
type PaneFlow = 'rows' | 'columns';

import StatusRail from './components/StatusRail';
import StreamCard from './components/StreamCard';
import VitalsCard from './components/VitalsCard';
import SelfCard from './components/SelfCard';
import type { SupplyList } from './components/SupplyControls';
import LoopsModal from './components/LoopsModal';
import ToolbarCard from './components/ToolbarCard';
import { TOOLBAR_ACTIONS, type ToolbarSubject } from './lib/toolbar';
import { useToolbarPins } from './hooks/useToolbarPins';
import NavigationCard from './components/NavigationCard';
import { type TerminalHandle } from './components/TerminalView';
import { useConfig } from './hooks/useConfig';
import {
  cardLabel,
  hidesWhenEmpty,
  useCardLayout,
  HIDES_WHEN_EMPTY,
  NO_CARD_SETTINGS,
  type CardId,
  type CardLayoutApi,
  type CardSettings,
  type Lane
} from './hooks/useCardLayout';
import type { CardChrome } from './components/BentoCard';
import type { AppConfig } from '@shared/config';
import type { IpcApi } from '@shared/ipc';
import { THEME_PREFERENCES, THEMES } from '@shared/themes';
import { usePaneWidths } from './hooks/usePaneWidths';
import { usePinnedCommands } from './hooks/usePins';
import { Splitter } from './components/Splitter';
import {
  CONSOLE_COLUMNS as MIN_COLUMNS,
  CONSOLE_ROWS,
  DOCK_RANGE,
  RAIL_RANGE,
  TAB_RAIL_RANGE,
  ceilingFor,
  type SplitRange
} from './lib/splitter';
import { useCardDrag } from './hooks/useCardDrag';
import { useCardResize } from './hooks/useCardResize';
import { reordered } from './lib/reorder';
import { useDensity } from './hooks/useDensity';
import { useHotkeys } from './hooks/useHotkeys';
import { useOverridablePreference } from './hooks/usePreference';
import { useTheme } from './hooks/useTheme';
import { useStreamPressure, ZERO_METER, type StreamMeter } from './hooks/useStreamPressure';
import { t } from './lib/i18n';
import { loopRows, type LoopChoice, type LoopDestination, type LoopHere } from './lib/loops';
import { chord } from './lib/platform';
import type { PopoverAnchor } from './lib/popover';
import { playerKey } from '@shared/players';
import {
  automationSwitches,
  AUTOMATION_SWITCH_NAMES,
  DEFAULT_CONFIG,
  resolveTerminalFonts,
  resolveUiFonts,
  targetFromServer,
  toCssFontStack,
  type AutomationSwitches,
  type RemotesConfig,
  type SupplyItem
} from '@shared/config';
import type { RemoteName } from '@shared/remotes';
import { EMPTY_CHARACTER, ownGang, type CharacterState } from '@shared/character';
import { IDLE_WALK, type WalkProgress } from '@shared/walk';
import { DEFAULT_INTERNAL, type InternalConfig } from '@shared/internal';
import { NO_LOOP, type Loop, type LoopProgress } from '@shared/loops';
import { EMPTY_AUTOMATION, type AutomationSnapshot } from '@shared/automation';
import type { Block } from '@shared/blocks';
import type { Discovery } from '@shared/memory';
import type { GlobalDraft, ProfileDraft, ServerDraft } from '@shared/drafts';
import {
  mayNotice,
  noticeFor,
  partyNotices,
  roomNotices,
  rosterNotices,
  vitalNotices,
  wanted,
  type Notice
} from '@shared/notifications';
import { roomId, type Route, type WorldNames, type WorldRoom } from '@shared/world';
import {
  NO_SESSION,
  type AttachSnapshot,
  type ProfileSummary,
  type SessionId,
  type SessionSummary
} from '@shared/ipc';
import type {
  ConnectionState,
  ConnectionTarget,
  StreamLine,
  TelnetEvent,
  TerminalSize
} from '@shared/types';
import { setTuning, tuning } from './lib/tuning';

const INITIAL_STATE: ConnectionState = {
  phase: 'idle',
  target: null,
  connectedAt: null,
  detail: null,
  negotiated: {
    localEnabled: [],
    remoteEnabled: [],
    binary: false,
    suppressGoAhead: false,
    remoteEcho: false
  }
};

/**
 * What this window knows about one character.
 *
 * Held per session rather than only for the one on screen, because the tab rail
 * reports vitals, room and current action for characters whose terminals it is
 * not showing — that is the whole reason the rail is worth having. The coalesced
 * channels already reach every window for every session, so this is a matter of
 * keeping what arrives rather than of asking for more.
 */
interface SessionView {
  state: ConnectionState;
  character: CharacterState;
  walk: WalkProgress;
  loop: LoopProgress;
  automation: AutomationSnapshot;
  lines: StreamLine[];
  telnet: TelnetEvent[];
  /**
   * What has been said, per character.
   *
   * The terminal carries every line, but it carries *everything* — a telepath
   * scrolls out of reach behind a combat burst within seconds, which is exactly
   * when nobody can go looking for it. Kept here so a second view of the same
   * stream can hold it.
   */
  talk: Block[];
  /**
   * What is worth knowing, ranked.
   *
   * Derived here rather than in main because it is a *reading* of facts that
   * already arrive, not a new fact: main publishes blocks and character state,
   * and turning those into "this deserves an alert" is presentation. Adding an
   * IPC channel for it would mean a second place that has to agree about what
   * counts as urgent.
   */
  notices: Notice[];
  /**
   * What has been raised while nobody was looking at this character.
   *
   * The point of running four characters is that three of them are unattended,
   * and the point of a tab rail is that it reports on the ones whose terminal
   * is not on screen. Vitals and walk state already reach it; *alerts* did not,
   * so a hostile arriving in an unattended character's room raised nothing
   * anybody would see.
   *
   * Cleared when the character is put on screen, because that is what "seen"
   * means. Counted rather than kept: the notices themselves are already in
   * `notices`, and a tab has room for a number.
   */
  unseen: { critical: number; warning: number; latest: string | null };
  /**
   * What this character has found that the realm data does not have.
   *
   * Per character rather than per realm, like the file it comes from: two
   * characters on one realm have been to different places, and the record is a
   * record of where *this* one has been.
   */
  learned: Discovery[];
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

/*
 * A laid-out element's box, for the splitter arithmetic. Measured from the
 * DOM, never a constant — the same rule the column floor follows.
 */
function widthOf(selector: string, fallback: number): number {
  return document.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width ?? fallback;
}
function heightOf(selector: string, fallback: number): number {
  return document.querySelector<HTMLElement>(selector)?.getBoundingClientRect().height ?? fallback;
}
/*
 * What each splitter measures, as functions it calls when a gesture starts
 * rather than figures computed on every render of the window: a
 * `getBoundingClientRect` in a render is a forced layout, three panes' worth
 * per commit.
 */
const measureTabs = (): number => widthOf('.workspace > .tab-rail', TAB_RAIL_RANGE.min);
const measureRail = (): number => widthOf('.workspace > .rail', RAIL_RANGE.min);
const measureAbove = (): number => heightOf('.dock-above > .card', DOCK_RANGE.min);
const measureBelow = (): number => heightOf('.dock-below > .card', DOCK_RANGE.min);

/** No characters loaded: one empty list, so the rail's props hold still while it is empty. */
const NO_SESSIONS: SessionSummary[] = [];
/** A character whose file names no supplies. One list, so a card's props hold still. */
const NO_SUPPLIES: SupplyItem[] = [];

const EMPTY_VIEW: SessionView = {
  state: INITIAL_STATE,
  character: EMPTY_CHARACTER,
  walk: IDLE_WALK,
  loop: NO_LOOP,
  automation: EMPTY_AUTOMATION,
  lines: [],
  telnet: [],
  talk: [],
  notices: [],
  unseen: { critical: 0, warning: 0, latest: null },
  learned: []
};

/**
 * Folds new notices into the unseen count for a character.
 *
 * A character on screen has seen them by definition, so nothing accumulates for
 * the one being played — the count exists for the other three. `info` is not
 * counted: a tab that lights up for somebody arriving in the realm is a tab
 * nobody reads, and the whole value of the mark is that it is rare.
 */
function missed(
  current: SessionView['unseen'],
  raised: Notice[],
  shown: boolean
): SessionView['unseen'] {
  if (shown) return current.critical === 0 && current.warning === 0 ? current : EMPTY_UNSEEN;
  const worth = raised.filter((notice) => notice.severity !== 'info');
  if (worth.length === 0) return current;
  return {
    critical: current.critical + worth.filter((n) => n.severity === 'critical').length,
    warning: current.warning + worth.filter((n) => n.severity === 'warning').length,
    // The newest, for the tab's title: a number says how much and this says what.
    latest: worth[worth.length - 1]!.text
  };
}

const EMPTY_UNSEEN = { critical: 0, warning: 0, latest: null } as const;

/** Keeps a log bounded without reallocating it on every append. */
function capped<T>(log: T[], entry: T, limit: number): T[] {
  const next = [...log, entry];
  return next.length > limit ? next.slice(-limit) : next;
}

/**
 * Everything a card reads, gathered so one function draws a card for *any*
 * character — the shown one, or one whose float is pinned in view.
 */
interface CardContext {
  session: SessionId;
  chrome: CardChrome;
  character: CharacterState;
  view: SessionView;
  inGame: boolean;
  thresholds: AppConfig['ui']['vitals'];
  /**
   * Whether the Navigation card is worth the space it takes: something walked
   * or looped recently enough to still be news, or loops to start.
   */
  navigationVisible: boolean;
  size: TerminalSize;
  /** The throughput readout for this character — a store the Session card subscribes to. */
  meter: StreamMeter;
  quiet: boolean;
  ask(command: string): void;
  /**
   * A gear button, addressed at this character.
   *
   * Not `ask`: that takes a bare verb of at most eight lowercase letters and
   * no argument, which is exactly what lets it accept a string from here. Main
   * holds the pack, the loadout and the realm's word on what can be worn, so
   * what crosses is an action from a closed list. See `shared/gear.ts`.
   */
  gear(action: GearAction, item?: string): void;
  forget(discovery: Discovery): void;
  inspect(name: string, anchor: HTMLElement): void;
  loadWearer(): ReturnType<IpcApi['wearer']>;
  loadMap(map: number, room: number, radius?: number): ReturnType<IpcApi['localMap']>;
  lookupName(query: string): ReturnType<IpcApi['lookup']>;
  /** Null for a character not shown: the route panel is the shown one's. */
  chooseOnMap: ((map: number, room: number) => void) | null;
  stopWalk(): void;
  stopLoop(): void;
  /**
   * The loop face's controls. `loops` is the character's own list to pick
   * from — null on a pinned float, whose list belongs to the shown character.
   */
  loops: ReadonlyArray<{ name: string; stops: number }> | null;
  startLoop(name: string): void;
  pauseLoop(): void;
  resumeLoop(): void;
  skipLoop(): void;
  reverseLoop(): void;
  /** Whose Player flyout is open from one of this character's listings, lower-cased, or null. */
  subject: string | null;
  /** The console's name index for this character, or null before the realm's names arrive. */
  nameIndex: NameIndex | null;
  /** A name clicked on the Realm or Players card, and where, for the flyout to open beside. */
  selectPlayer(name: string, anchor: PopoverAnchor): void;
  /** This character's resolved `automation.remotes`, for the Gang card. */
  remotes: RemotesConfig;
  /** The toolbar: this character's own switches, and what its buttons do. */
  toolbar: ToolbarSubject;
  /** Which toolbar buttons are on the row, and the control that moves one. */
  toolbarPinned: ReadonlySet<string>;
  pinToolbarButton(id: string): void;
  /** The gang's whole list, and whether the gangpath is answered on. */
  setGangRemotes(remotes: RemoteName[]): void;
  setGangpath(on: boolean): void;
  /**
   * This character's supplies list and the write, for the Self card and the
   * item panel — resolved per character like `remotes`, and addressed.
   */
  supplies: SupplyList;
  /** The tab's own name for the character, for the Self card before the sheet prints. */
  profileName: string;
  onSend?(line: string): void;
}

/**
 * The addressed callbacks a card receives — the always-addressed ones (`gear`,
 * `selectPlayer`, the gang writes) and every one a pinned float gets in place
 * of the shown character's. Built once per character and cached (`boundFor` in
 * `App`), because every card is memoised and a fresh closure per render
 * defeats that wholesale — which was most of what a state flush cost.
 */
interface AddressedActions {
  ask(command: string): void;
  forget(discovery: Discovery): void;
  gear(action: GearAction, item?: string): void;
  loadWearer(): ReturnType<IpcApi['wearer']>;
  loadMap(map: number, room: number, radius?: number): ReturnType<IpcApi['localMap']>;
  lookupName(query: string): ReturnType<IpcApi['lookup']>;
  stopWalk(): void;
  stopLoop(): void;
  startLoop(name: string): void;
  pauseLoop(): void;
  resumeLoop(): void;
  skipLoop(): void;
  reverseLoop(): void;
  selectPlayer(name: string, anchor: PopoverAnchor): void;
  setGangRemotes(remotes: RemoteName[]): void;
  setGangpath(on: boolean): void;
  setSupplies(items: SupplyItem[]): void;
  send(line: string): void;
}

/**
 * The map's answer to a click on a pinned float, where there is no route panel
 * to open. A module constant so the memoised card sees the same value every
 * render — an inline fallback was a fresh prop per render.
 */
const NO_CHOICE = (): void => undefined;

/**
 * Whether a card that *can* be empty holds its place while it is.
 *
 * One test for the five cards that have an "is there anything to say" answer,
 * rather than the five different hard-coded ones they each grew: Party and
 * Navigation took themselves off the rail, Combat did until todo 04, and Gang
 * and Banks never did. `HIDES_WHEN_EMPTY` carries what each one did before as
 * its default, so nothing moved on anybody's rail — what changed is that the
 * other answer is now reachable, from the card's own gear.
 */
function emptyCardHidden(chrome: CardChrome, id: CardId, hasSomethingToSay: boolean): boolean {
  if (hasSomethingToSay) return false;
  return hidesWhenEmpty(chrome.settings?.value ?? NO_CARD_SETTINGS, id);
}

/** The card for an id, drawn from a context. Exhaustive over the vocabulary. */
function cardElement(id: CardId, ctx: CardContext): ReactNode {
  const { chrome, character, view } = ctx;
  switch (id) {
    case 'self':
      return (
        <SelfCard
          {...chrome}
          character={character}
          gear={ctx.gear}
          inspect={ctx.inspect}
          loadWearer={ctx.loadWearer}
          profileName={ctx.profileName}
          session={ctx.session}
          /*
            Addressed at `sid` like the gang's list — and null on a pinned
            float only for the *write*: the list is drawn from its own
            character's summary, and a control that wrote the shown
            character's file from another character's card would be the
            failure every addressed field here exists to refuse.
          */
          supplies={ctx.chooseOnMap === null ? null : ctx.supplies}
          suppliesOn={ctx.toolbar.switches.supplies}
        />
      );
    case 'vitals':
      return (
        <VitalsCard
          {...chrome}
          ask={ctx.ask}
          character={character}
          session={ctx.session}
          thresholds={ctx.thresholds}
        />
      );
    case 'room':
      return (
        <RoomCard
          {...chrome}
          ask={ctx.ask}
          character={character}
          session={ctx.session}
          forget={ctx.forget}
          inspect={ctx.inspect}
          learned={view.learned}
        />
      );
    case 'map':
      // A map of nowhere states nothing.
      return character.room.map === null ? null : (
        <MapCard
          {...chrome}
          character={character}
          load={ctx.loadMap}
          // This character's own route and lap, drawn over its own
          // neighbourhood — a pinned float belongs to somebody else.
          loop={view.loop}
          // The map's rooms stay drawn as they are on a float; with no panel to
          // open for that character, the click is answered by nothing.
          onChoose={ctx.chooseOnMap ?? NO_CHOICE}
          walk={view.walk}
        />
      );
    case 'navigation':
      // An idle walker and an idle loop are not conditions, and a card that
      // always says "nothing" is chrome. One test for both halves, so the card
      // does not appear for one face and vanish for the other — and it is the
      // same test every other emptiable card takes, so it can be turned off.
      if (emptyCardHidden(chrome, id, ctx.navigationVisible)) return null;
      return (
        <NavigationCard
          {...chrome}
          character={character}
          loop={view.loop}
          loops={ctx.loops}
          onChoose={ctx.chooseOnMap}
          onPauseLoop={ctx.pauseLoop}
          onResumeLoop={ctx.resumeLoop}
          onReverseLoop={ctx.reverseLoop}
          onSkipLoop={ctx.skipLoop}
          onStartLoop={ctx.startLoop}
          onStopLoop={ctx.stopLoop}
          onStopWalk={ctx.stopWalk}
          walk={view.walk}
        />
      );
    case 'notifications':
      return (
        <NotificationsCard
          {...chrome}
          character={character}
          inspect={ctx.inspect}
          names={ctx.nameIndex}
          notices={view.notices}
          onSelect={ctx.selectPlayer}
          session={ctx.session}
        />
      );
    case 'realm':
      return (
        <RealmCard
          {...chrome}
          character={character}
          onSelect={ctx.selectPlayer}
          session={ctx.session}
          subject={ctx.subject}
        />
      );
    case 'players':
      return (
        <PlayersCard
          {...chrome}
          character={character}
          onSelect={ctx.selectPlayer}
          session={ctx.session}
          subject={ctx.subject}
        />
      );
    case 'gang':
      /*
       * Held whether or not this character is in one, by default: the card
       * carries the `@` permission grid, which is worth reaching whatever the
       * roster last said, and `ownGang` is `undefined` until something has
       * asked. Somebody who only wants it while there is a gang says so on the
       * gear — and a gang is learned from the wire, so that is a card which can
       * come and go on its own.
       */
      if (emptyCardHidden(chrome, id, ownGang(character) != null)) return null;
      return (
        <GangCard
          {...chrome}
          ask={ctx.ask}
          character={character}
          onSelect={ctx.selectPlayer}
          onSetGangRemotes={ctx.setGangRemotes}
          onSetGangpath={ctx.setGangpath}
          remotes={ctx.remotes}
          session={ctx.session}
          subject={ctx.subject}
        />
      );
    case 'party':
      // Only while there is one, by default: a card that always says
      // "travelling alone" is chrome, and it sits above the rest of the rail.
      // Somebody who would rather it held its place says so on its gear.
      if (emptyCardHidden(chrome, id, character.party.members.length > 0)) return null;
      return (
        <PartyCard
          {...chrome}
          ask={ctx.ask}
          character={character}
          onSelect={ctx.selectPlayer}
          subject={ctx.subject}
          thresholds={ctx.thresholds}
        />
      );
    case 'combat': {
      /*
       * Drawn whether or not there is a fight, unless this character has asked
       * otherwise.
       *
       * It used to be the other way round and unconditionally so: the card
       * arrived when a fight began and left when it ended, which on a busy
       * route is several times a minute — and every card below it on the rail
       * moved each time. That is the churn a fixed card exists to prevent,
       * done to the rail by the rail's own contents, and it made the controls
       * under it a moving target while a fight was the exact thing somebody
       * was reacting to.
       *
       * So the default is *always show* — the card has something true to say
       * either way, and it says `Nothing is fighting you` rather than nothing
       * at all. The other answer is on the card's own gear.
       */
      const fighting = character.inCombat || character.combat.attackers.length > 0;
      if (emptyCardHidden(chrome, id, fighting)) return null;
      return (
        <CombatCard
          {...chrome}
          character={character}
          inspect={ctx.inspect}
          onSelect={ctx.selectPlayer}
        />
      );
    }
    case 'inventory':
      return (
        <InventoryCard
          {...chrome}
          character={character}
          gear={ctx.gear}
          inspect={ctx.inspect}
          loadWearer={ctx.loadWearer}
          session={ctx.session}
        />
      );
    case 'banks':
      /*
       * Unconditional, unlike Party and Combat. Those say nothing at all when
       * the character is alone or idle; this one has something true to say
       * either way — a vault's balance, or that no vault has been asked, which
       * is the answer to "where is my money" for a character who has banked
       * nowhere. It is put away by default instead, so the rail is not spent on
       * it until somebody asks for it — and somebody who wants it on the rail
       * only once a counter has answered says so on its gear.
       */
      if (emptyCardHidden(chrome, id, character.banks.length > 0)) return null;
      return <BanksCard {...chrome} character={character} />;
    case 'stats':
      /*
       * Unconditional: it has something true to say from the first blow, and
       * *nothing yet* is itself the answer for a character that has not swung.
       * It is put away by default instead, so the rail is not spent on it.
       */
      return <StatsCard {...chrome} character={character} session={ctx.session} />;
    case 'reference':
      return (
        <ReferenceCard
          {...chrome}
          level={character.progress.level}
          lookup={ctx.lookupName}
          /*
            Addressed like `lookup` and `onRoom` beside it: the panel it opens
            is the *shown* character's, and this card's whole content is realm
            data. On a pinned float belonging to a character on another
            `world.database`, a monster clicked in `Dropped by` would otherwise
            be resolved against the wrong realm — so it stays text there, which
            is what a control bound to nowhere should be.
          */
          onName={ctx.chooseOnMap === null ? null : ctx.inspect}
          onRoom={ctx.chooseOnMap}
          realm={character.realm}
          supplies={ctx.chooseOnMap === null ? null : ctx.supplies}
        />
      );
    case 'conversation':
      return (
        <ConversationCard
          {...chrome}
          messages={view.talk}
          session={ctx.session}
          // Only while there is somewhere for it to go. A composer on an
          // offline character is a box that silently does nothing, and the
          // backlog is still worth reading without one.
          onSend={ctx.inGame ? ctx.onSend : undefined}
          onSelect={ctx.selectPlayer}
          // The `original` layout quotes the realm's whole sentence, so the
          // names in it are found the way the Alerts card finds them — through
          // the console's own index, so the two cannot disagree about what is
          // a name.
          inspect={ctx.inspect}
          names={ctx.nameIndex}
          character={character}
        />
      );
    case 'session':
      return <SessionCard {...chrome} meter={ctx.meter} size={ctx.size} state={view.state} />;
    case 'link':
      return (
        <LinkCard
          {...chrome}
          events={view.telnet}
          negotiated={view.state.negotiated}
          quiet={ctx.quiet}
        />
      );
    case 'toolbar':
      return (
        <ToolbarCard
          {...chrome}
          onPinButton={ctx.pinToolbarButton}
          pinnedButtons={ctx.toolbarPinned}
          subject={ctx.toolbar}
        />
      );
    case 'automation':
      return <AutomationCard {...chrome} automation={view.automation} />;
    case 'stream':
      return <StreamCard {...chrome} lines={view.lines} quiet={ctx.quiet} />;
    default: {
      /*
       * Exhaustive, and a compile error if it stops being.
       *
       * A card id in the vocabulary with no case here would render nothing,
       * for ever, while still appearing in the picker and the palette as
       * something to add — a control that does nothing and says nothing.
       * The same shape as a guard field the parser does not know and a
       * block type nothing produces; this one the type system can catch.
       */
      const unreachable: never = id;
      return unreachable;
    }
  }
}

/**
 * Another character's pinned floats, drawn over the console beside the shown
 * character's. A component per character rather than a loop of hooks: each
 * layout is that character's own, read by the same hook the rail uses.
 */
function PinnedFloats({
  sid,
  boxRef,
  render,
  onStreamFloat
}: {
  sid: SessionId;
  boxRef: React.RefObject<HTMLElement>;
  render(id: CardId, sid: SessionId, layout: CardLayoutApi): ReactNode;
  /** Whether this character's pinned floats include the Stream card. */
  onStreamFloat(sid: SessionId, has: boolean): void;
}) {
  const layout = useCardLayout(sid);
  /*
   * Reported upward because the line feed is per *window*: only this component
   * reads this character's layout, and the window-level interest has to count
   * a pinned stream float or it would quietly freeze with the rail closed.
   */
  const hasStream = layout.floats.some((float) => float.pinned === true && float.id === 'stream');
  useEffect(() => {
    onStreamFloat(sid, hasStream);
    return () => onStreamFloat(sid, false);
  }, [sid, hasStream, onStreamFloat]);
  return (
    <FloatLayer
      boxRef={boxRef}
      layout={layout}
      only={(float) => float.pinned === true}
      render={(id) => render(id, sid, layout)}
    />
  );
}

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
  const [views, setViews] = useState<Record<SessionId, SessionView>>({});

  /**
   * The characters on screen, one per pane, and which pane the keyboard is
   * talking to.
   *
   * Flat and at most four: a recursive split tree needs a layout algebra, drag
   * handles and a serialisation format, and pays that back for someone tiling
   * six documents rather than watching four characters. See docs/profiles.md
   * §7.3.
   */
  const [paneIds, setPaneIds] = useState<SessionId[]>([]);
  const [focusedPane, setFocusedPane] = useState(0);

  /**
   * The panes, filtered to characters that are still loaded.
   *
   * Derived rather than corrected in place: a character closing while it is on
   * screen must not leave a pane pointing at an id nothing answers to, and
   * there is always at least one pane while there is at least one character.
   */
  const panes = useMemo(() => {
    const live = paneIds.filter((id) => sessions.some((entry) => entry.id === id));
    if (live.length > 0) return live;
    return sessions.length > 0 ? [sessions[0]!.id] : [];
  }, [paneIds, sessions]);

  const paneAt = Math.min(focusedPane, Math.max(0, panes.length - 1));
  const session = panes[paneAt] ?? NO_SESSION;

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

  const view = views[session] ?? EMPTY_VIEW;
  const { state, character, walk, automation, lines } = view;
  const telnetEvents = view.telnet;
  const [size, setSize] = useState<TerminalSize>({ cols: 80, rows: 24 });
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Stable, because the status rail is memoised and an arrow here re-drew it
  // on every commit of the window.
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  /*
   * The Loops modal. A plain `useState`, deliberately not a remembered
   * preference: it is a thing reached for, used and put down — the shape the
   * diagnostics rail settled on — and a modal that reopened itself on every
   * launch because somebody once looked at it is chrome nobody asked for.
   */
  const [loopsOpen, setLoopsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [routeOpen, setRouteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /*
   * Which character the settings screen opens on.
   *
   * `null` means "wherever it was", which is what `Ctrl/Cmd ,` and the palette
   * want — reopening the screen on the character you were last editing. A tab's
   * own menu names one, because "edit *this* character" is the whole point of
   * reaching it from the tab rather than from the palette.
   */
  const [settingsAt, setSettingsAt] = useState<string | null>(null);
  /** A destination picked off the map, planned when the panel opens. */
  const [routeTarget, setRouteTarget] = useState<WorldRoom | null>(null);
  /** A room name clicked in the console that named more than one room. */
  const [routeSearch, setRouteSearch] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<SearchResult | undefined>(undefined);
  /** The name last clicked on a card, and where, so the answer can open beside it. */
  const [asked, setAsked] = useState<Asked | null>(null);
  /**
   * The Player flyout: whose it is about, which character's listing it was
   * opened from, and where on screen. One at a time, like the reference
   * slide-out, and **not** remembered across launches, unlike a card's
   * filters: a filter is a standing choice and is remembered, a find is a
   * question being asked right now and is not — and a clicked name is a find.
   * The registry it names dies with the session anyway
   * (`src/shared/players.ts`), so a stored name would point at nobody on every
   * launch.
   */
  const [flyout, setFlyout] = useState<PlayerAsked | null>(null);
  /**
   * The Gang flyout, on the same terms as the Player one and mutually exclusive
   * with it: a gang's panel is clicked *through* to a person's, and two panels
   * hanging off two names is two things to put away and no way to say which
   * Escape means.
   */
  const [gangFlyout, setGangFlyout] = useState<GangAsked | null>(null);

  const { config, path: configPath, loadedAt } = useConfig();
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

  /*
   * The shipped shelf, fetched the first time the modal is opened and kept.
   *
   * Not at launch: it is four hundred and twenty loops, and most sessions
   * never open this — the same reason the settings screen asks for it on the
   * Movement tab rather than carrying it in the snapshot. Kept afterwards
   * because the file is inside the application and changes only when the
   * application does, which is `LoopCatalogue`'s own reason for reading it
   * once.
   */
  const [catalogue, setCatalogue] = useState<Loop[] | null>(null);
  useEffect(() => {
    if (!loopsOpen || catalogue !== null) return;
    let stale = false;
    void api
      .loopCatalogue()
      .then((list) => {
        if (!stale) setCatalogue(list);
      })
      .catch((error: unknown) => {
        /*
         * An empty shelf, said out loud, rather than "Reading the loops…" for
         * ever. `LoopCatalogue` already answers a missing file with an empty
         * list, so reaching here means the call itself failed — and a modal
         * left spinning is a feature that looks broken with nothing anywhere
         * saying why. The character's own loops are still listed, which is
         * what makes an empty shelf usable rather than fatal.
         */
        if (stale) return;
        setCatalogue([]);
        terminals.current
          .get(session)
          ?.notice(t('loops.catalogueFailed', { reason: String(error) }));
      });
    return () => {
      stale = true;
    };
  }, [api, loopsOpen, catalogue, session]);

  /*
   * The shelf and this character's own, as the rows the modal draws.
   *
   * Memoised on both, so a status line republishing `character` does not
   * rebuild four hundred rows — the reason `askable` is memoised on its own
   * beside the palette's commands.
   */
  const loopChoices = useMemo(() => loopRows(catalogue ?? [], loops), [catalogue, loops]);

  /*
   * Where this character is, for the sections the modal draws above the areas.
   *
   * `view.loop.name` outlives the run it named — `stopped` keeps it, which is
   * the same reason the Navigation card's Loop face keeps showing a loop after
   * it has ended — so this is *the last loop walked*, not *the loop running*,
   * which is the one somebody reaching for this modal most often wants back.
   * Null before a session has run one, and the section is then simply absent.
   *
   * The room is taken from the tracker as it stands: the name the server
   * printed and the coordinates the client resolved, each independently null.
   * Neither is repaired here — a room the client has not placed matches no
   * stop, which is right, because "I do not know where you are" must not come
   * out as "every loop starts here". Memoised on the three values rather than
   * on `character`, so a status line arriving twice a second does not re-group
   * four hundred rows.
   */
  const loopHere = useMemo<LoopHere>(
    () => ({
      recent: view.loop.name,
      roomName: character.room.name,
      at:
        character.room.map === null || character.room.number === null
          ? null
          : { map: character.room.map, room: character.room.number }
    }),
    [view.loop.name, character.room.name, character.room.map, character.room.number]
  );

  /*
   * The live thresholds, readable from a subscription registered once.
   *
   * The block and character subscriptions are set up for the window's lifetime
   * and must not be torn down and rebuilt every time the options file is saved
   * — a resubscribe drops whatever arrives in the gap. A ref lets the handler
   * read the current value without becoming a dependency of it.
   */
  const vitalsRef = useRef(config.ui.vitals);
  vitalsRef.current = config.ui.vitals;
  /*
   * What this character wants to be alerted about, read the same way and for
   * the same reason: the subscriptions below are registered once for the
   * window's lifetime and must not be torn down every time the options file is
   * saved.
   */
  const alertsRef = useRef(config.ui.alerts);
  alertsRef.current = config.ui.alerts;
  const { density, preference, cycle } = useDensity(config.ui.density);
  /*
   * The shown character's theme, when its file states one; the options file's
   * otherwise. A palette pick still outranks either until the file changes,
   * which is `useOverridablePreference`'s rule and is unchanged here.
   */
  const characterTheme = profiles.find((profile) => profile.id === session)?.theme;

  /**
   * One character's resolved `automation.remotes`, for the Player flyout and
   * the Gang card.
   *
   * Off the *profile*, not off `config`: a character states this sparsely over
   * the options file, and the global block alone would tell a pinned float that
   * somebody is trusted when the character it belongs to trusts nobody. The
   * float rule — every control on it bound to its own character — is the same
   * reason `theme` is read this way.
   *
   * A character with no summary yet falls back to the shipped default, which
   * trusts nobody: an unknown permission must never read as an allowance.
   */
  const remotesFor = useCallback(
    (id: SessionId): RemotesConfig =>
      profiles.find((profile) => profile.id === id)?.remotes ?? DEFAULT_CONFIG.automation.remotes,
    [profiles]
  );
  /**
   * This character's supplies list, resolved, and its display name — read the
   * way `remotesFor` is and for its reason: a list drawn off the global block
   * would show every character the same one.
   */
  const suppliesFor = useCallback(
    (id: SessionId): SupplyItem[] =>
      profiles.find((profile) => profile.id === id)?.supplies.items ?? NO_SUPPLIES,
    [profiles]
  );
  const profileNameFor = useCallback(
    (id: SessionId): string => profiles.find((profile) => profile.id === id)?.name ?? id,
    [profiles]
  );
  /**
   * This character's own automation switches, resolved, for the toolbar.
   *
   * Read the same way and for the same reason as `remotesFor`: a character
   * states these sparsely over the options file, so the global block alone
   * would draw a pinned float's toolbar with the *shown* character's answers.
   *
   * A character with no summary yet falls back to the shipped default, which
   * has everything off — the safe direction, and the same one an unknown
   * permission takes.
   */
  const switchesFor = useCallback(
    (id: SessionId): AutomationSwitches =>
      profiles.find((profile) => profile.id === id)?.switches ??
      automationSwitches(DEFAULT_CONFIG.automation),
    [profiles]
  );
  /**
   * The ceiling this character rests to, resolved, for the rail's mark.
   *
   * Read the same way and for the same reason as `remotesFor` and
   * `switchesFor`: the rail reports on the characters nobody is looking at, so
   * a figure taken from the global block would say the same thing for all four
   * whatever their own files state.
   *
   * A character with no summary yet falls back to **0**, and deliberately not
   * to the shipped default. 0 draws the bare word `resting`, which is the
   * modest claim; the shipped ceiling is 0.7, and drawing `resting to 70%` for
   * a character whose file has not arrived would put a specific figure on a tab
   * on the strength of a guess. Unknown is not the reassuring answer, and here
   * the reassuring answer is the precise one.
   */
  const restToFor = useCallback(
    (id: SessionId): number => profiles.find((profile) => profile.id === id)?.restTo ?? 0,
    [profiles]
  );
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
  const {
    theme,
    preference: themePreference,
    cycle: cycleTheme,
    choose: chooseTheme
  } = useTheme(characterTheme ?? config.ui.theme);

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
   * Characters other than the shown one whose *pinned* floats include the
   * Stream card. The per-line feed is sent only while something in this window
   * shows it (see `wantsLineFeed`), and a pinned stream float is the one
   * consumer the shown character's layout cannot answer for — uncounted, it
   * would quietly freeze whenever the rail was closed.
   */
  const [pinnedStreams, setPinnedStreams] = useState<ReadonlySet<SessionId>>(() => new Set());
  const noteStreamFloat = useCallback((sid: SessionId, has: boolean) => {
    setPinnedStreams((prev) => {
      if (prev.has(sid) === has) return prev;
      const next = new Set(prev);
      if (has) next.add(sid);
      else next.delete(sid);
      return next;
    });
  }, []);

  /** Same precedence as density and theme: remembered, overridden by the file. */
  const [tabSide, setTabSide] = useOverridablePreference<RailSide>(
    'mudengine.tabs',
    config.ui.tabs,
    (value): value is RailSide => value === 'top' || value === 'left'
  );

  /**
   * Stacked or side by side.
   *
   * Stacked is the default because rows are cheap and columns are not: the
   * console needs 80 of them and no server in this family will format to fewer.
   * That is the opposite of the browser convention, and it follows from the
   * game rather than from taste.
   */
  const [paneFlow, setPaneFlow] = useOverridablePreference<PaneFlow>(
    'mudengine.panes',
    'rows',
    (value): value is PaneFlow => value === 'rows' || value === 'columns'
  );

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
  const rangeFor = useCallback(
    (which: 'rail' | 'tabs' | 'above' | 'below'): SplitRange => {
      const box = layersRef.current;
      if (which === 'above' || which === 'below') {
        // A strip takes rows from the console; it keeps its own floor of them.
        const current = heightOf(`.dock-${which} > .card`, DOCK_RANGE.min);
        if (!box || size.rows <= 0) return DOCK_RANGE;
        return ceilingFor(
          DOCK_RANGE,
          current,
          box.clientHeight,
          box.clientHeight / size.rows,
          CONSOLE_ROWS
        );
      }
      const base = which === 'rail' ? RAIL_RANGE : TAB_RAIL_RANGE;
      const current = widthOf(
        which === 'rail' ? '.workspace > .rail' : '.workspace > .tab-rail',
        base.min
      );
      if (!box || size.cols <= 0) return base;
      return ceilingFor(base, current, box.clientWidth, box.clientWidth / size.cols);
    },
    [size.cols, size.rows]
  );
  const workspaceRef = useRef<HTMLDivElement>(null);
  const drag = useCardDrag(cards, workspaceRef);

  /*
   * Read through refs by the cached chrome and callback bundles below, which
   * are built once and must not go stale: a closure that captured `cards` or
   * `drag` by value would act on the layout as it stood when the card was
   * first drawn. The render-time assignment is the pattern `TerminalView`'s
   * handlers already use.
   */
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const dragRef = useRef(drag);
  dragRef.current = drag;
  // The corner grip on a rail card, the same shape as the float's: one axis,
  // stored as a fraction of the rail. Through a ref for the reason `dragRef`
  // is — a card's chrome is cached and must not close over a stale gesture.
  const resize = useCardResize(cards);
  const resizeRef = useRef(resize);
  resizeRef.current = resize;
  // A put-away card's chip is a handle too (see `CardPicker`); through the
  // ref so the picker's props hold still between drags.
  const grabCard = useCallback(
    (id: CardId, event: React.PointerEvent<HTMLElement>) =>
      dragRef.current.begin(id, event, { fromControl: true }),
    []
  );

  /*
   * What each splitter reads when a gesture or a key needs the pane's width,
   * and the range it is clamped to. Stable callbacks, because the splitters
   * are memoised and an arrow per render redrew all of them on every commit;
   * the measuring itself moved out of the render path with them — see
   * `Splitter`.
   */
  const rangeForTabs = useCallback(() => rangeFor('tabs'), [rangeFor]);
  const rangeForRail = useCallback(() => rangeFor('rail'), [rangeFor]);
  const rangeForAbove = useCallback(() => rangeFor('above'), [rangeFor]);
  const rangeForBelow = useCallback(() => rangeFor('below'), [rangeFor]);
  const resetTabs = useCallback(() => widths.setTabs(Number.NaN), [widths.setTabs]);
  const resetAbove = useCallback(() => widths.setAbove(Number.NaN), [widths.setAbove]);
  const resetBelow = useCallback(() => widths.setBelow(Number.NaN), [widths.setBelow]);

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

  /**
   * The terminal's handle, published once xterm has mounted. Chunks that arrive
   * before then are buffered rather than dropped, so nothing is lost if the
   * main process pushes during the first paint.
   */
  /**
   * Every mounted terminal, by character.
   *
   * They all stay mounted (see `SessionTerminal`), so this is how the window
   * reaches the one it is showing — to focus it, to search it, or to print an
   * engine message into it.
   */
  const terminals = useRef(new Map<SessionId, TerminalHandle>());
  /** Bumped when a terminal registers or leaves, so effects can react to it. */
  const [handleTick, setHandleTick] = useState(0);
  const pendingNotices = useRef<string[]>([]);

  /** The character on screen, for callbacks that must not go stale. */
  /**
   * Which characters are on screen right now.
   *
   * A set rather than a single id, because a split shows several at once and
   * all of them count as seen. Read through a ref for the same reason
   * `vitalsRef` is: these subscriptions are registered for the window's
   * lifetime and must not be rebuilt every time somebody changes tab.
   */
  const shownRef = useRef<Set<SessionId>>(new Set());

  const activeRef = useRef(session);
  useEffect(() => {
    activeRef.current = session;
  }, [session]);

  /** For the line-feed catch-up, which must not re-run on a roster push. */
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

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
   */
  const returnFocus = useCallback(() => {
    window.requestAnimationFrame(() => activeTerminal()?.focus());
  }, [activeTerminal]);

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
   * View patches queue and flush together, at most every
   * `tuning.chromeFlushMs` — chrome must never be able to pace the stream.
   *
   * Applying each push as its own state update re-rendered every card on the
   * rail per pushed fact, and on a busy realm that is many times a second: the
   * renderer spent its whole budget redrawing chrome and the console's own
   * writes — the player's echoed keystrokes among them — queued behind it.
   * Leading edge, so a lone change still paints at once; the sweep behind it
   * catches whatever a burst adds. One queue for every caller, because a
   * direct write landing between queued patches would apply them out of the
   * order they were pushed in.
   */
  const pendingPatches = useRef(new Map<SessionId, Array<(view: SessionView) => SessionView>>());
  const patchTimer = useRef<number | null>(null);
  const flushPatches = useCallback(() => {
    const batch = pendingPatches.current;
    if (batch.size === 0) return;
    pendingPatches.current = new Map();
    setViews((prev) => {
      const next = { ...prev };
      for (const [id, patches] of batch) {
        next[id] = patches.reduce((view, patch) => patch(view), next[id] ?? EMPTY_VIEW);
      }
      return next;
    });
  }, []);
  const patchView = useCallback(
    (id: SessionId, patch: (view: SessionView) => SessionView) => {
      const batch = pendingPatches.current;
      const queued = batch.get(id);
      if (queued) queued.push(patch);
      else batch.set(id, [patch]);
      if (patchTimer.current !== null) return;
      flushPatches();
      patchTimer.current = window.setTimeout(() => {
        patchTimer.current = null;
        flushPatches();
      }, tuning().chromeFlushMs);
    },
    [flushPatches]
  );
  useEffect(
    () => () => {
      if (patchTimer.current !== null) window.clearTimeout(patchTimer.current);
    },
    []
  );

  const applySnapshot = useCallback(
    (id: SessionId, snapshot: AttachSnapshot) => {
      patchView(id, () => ({
        state: snapshot.state,
        character: snapshot.character,
        walk: snapshot.walk,
        loop: snapshot.loop,
        automation: snapshot.automation,
        lines: snapshot.lines.slice(-tuning().lineLogLimit),
        telnet: snapshot.telnet.slice(-tuning().telnetLogLimit),
        // The conversation log's tail: main keeps what was said on disk, so a
        // restart restores the Talk card instead of starting it empty.
        talk: snapshot.talk.slice(-tuning().talkLimit),
        notices: [],
        // A window that has just attached has not missed anything: the
        // backscroll it replays is the record, and a count of alerts raised
        // before it existed is a number nobody can act on.
        unseen: { critical: 0, warning: 0, latest: null },
        learned: snapshot.learned
      }));
    },
    [patchView]
  );

  /*
   * Putting a character on screen is what "seen" means, so its unseen count
   * clears here rather than on a click: a split that brings a second character
   * up, a pane closing, and a tab switch are all the same event as far as
   * having looked at it is concerned.
   */
  useEffect(() => {
    shownRef.current = new Set(panes);
    for (const id of panes) {
      patchView(id, (v) =>
        v.unseen.critical === 0 && v.unseen.warning === 0 ? v : { ...v, unseen: EMPTY_UNSEEN }
      );
    }
  }, [panes, patchView]);

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

  /**
   * Whether anything in this window is showing the per-line diagnostics feed.
   *
   * `Push.line` is the one push that arrives at stream rate, and only the
   * Stream card reads it — hidden by default — so main sends it only while
   * this window has declared interest. Opening the feed re-asks for the
   * retained lines rather than replaying the pushes missed while it was
   * closed.
   */
  const wantsLineFeed = railOpen || cards.floatOf('stream') !== undefined || pinnedStreams.size > 0;
  /**
   * Whether main currently has this window's feed on. A tab switch away from
   * a character with a pinned stream float reads as *off* for one commit —
   * the float's report lands a commit later — and acting on that flap would
   * stop the feed and re-fetch every session per switch. So the on edge is
   * immediate and skips the catch-up when the feed never actually stopped,
   * and the off edge waits out a flap before standing down.
   */
  const feedOnRef = useRef(false);
  useEffect(() => {
    if (wantsLineFeed) {
      const wasOn = feedOnRef.current;
      feedOnRef.current = true;
      api.diagnostics(true);
      if (wasOn) return;
      for (const entry of sessionsRef.current) {
        const sid = entry.id;
        void api.getLines(sid).then((lines) =>
          patchView(sid, (v) => {
            /*
             * The fetch is a snapshot of a *growing* log, so it must not
             * replace outright: a line pushed while the fetch was in the air
             * is applied ahead of this patch, and replacing dropped it from
             * the one card whose job is to be the faithful record of framing.
             * Everything at or before the fetch's newest line is superseded
             * by the fetch; everything after it is kept. `at` guards the seam
             * too, because `seq` restarts per connection and a stale line
             * from an older session can carry a higher one.
             */
            const fetched = lines.slice(-tuning().lineLogLimit);
            const newest = fetched[fetched.length - 1];
            if (!newest) return v;
            const tail = v.lines.filter((line) => line.seq > newest.seq && line.at >= newest.at);
            return { ...v, lines: [...fetched, ...tail].slice(-tuning().lineLogLimit) };
          })
        );
      }
      return;
    }
    const settle = window.setTimeout(() => {
      feedOnRef.current = false;
      api.diagnostics(false);
    }, tuning().chromeFlushMs);
    return () => window.clearTimeout(settle);
  }, [api, wantsLineFeed, patchView]);

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

  /**
   * Facts about every character, kept for every character.
   *
   * These channels are addressed but not filtered: the tab rail draws vitals
   * and current action for characters this window is not showing, which is the
   * point of the rail. They are coalesced and low-rate, so keeping all of them
   * costs a state update per change rather than per line.
   */
  useEffect(() => {
    const off = [
      api.onState(({ session: id, payload }) => patchView(id, (v) => ({ ...v, state: payload }))),
      api.onCharacter(({ session: id, payload }) =>
        patchView(id, (v) => {
          /*
           * The one genuinely urgent thing in a MUD is a number, and the server
           * never announces it — it prints a smaller figure in a status line
           * that has printed a hundred already. So the alert comes from the
           * *crossing*, which needs the previous state, which is exactly what a
           * patch has in hand.
           *
           * Thresholds come from the live config through a ref: this
           * subscription is registered once for the window's lifetime and must
           * not be torn down and rebuilt every time the options file is saved.
           */
          const raised = wanted(alertsRef.current, [
            ...vitalNotices(v.character, payload, vitalsRef.current, t),
            // Who is in the realm is the other thing that arrives as a state
            // change rather than as a line worth alerting on: an arrival is a
            // name, and what the realm thinks of them lands with the next
            // listing. Both moments are worth reporting and they are not the
            // same moment.
            ...rosterNotices(v.character, payload, t),
            // A hostile in the *room* is not the same fact as one in the realm,
            // and it is raised from the room because the line that says
            // somebody walked in does not say what they are.
            ...roomNotices(v.character, payload, t),
            /*
             * And somebody in the party in trouble, which is the reason the
             * roster matters: three of four characters are unattended, and the
             * one being watched is not usually the one that is dying.
             */
            ...partyNotices(v.character, payload, vitalsRef.current.hp, t)
          ]);
          return {
            ...v,
            character: payload,
            notices: raised.reduce(
              (log, notice) => capped(log, notice, tuning().noticeLimit),
              v.notices
            ),
            unseen: missed(v.unseen, raised, shownRef.current.has(id))
          };
        })
      ),
      api.onWalk(({ session: id, payload }) => patchView(id, (v) => ({ ...v, walk: payload }))),
      api.onLoop(({ session: id, payload }) => patchView(id, (v) => ({ ...v, loop: payload }))),
      api.onLearned(({ session: id, payload }) =>
        patchView(id, (v) => ({ ...v, learned: payload }))
      ),
      api.onAutomation(({ session: id, payload }) =>
        patchView(id, (v) => ({ ...v, automation: payload }))
      ),
      api.onTelnet(({ session: id, payload }) =>
        patchView(id, (v) => ({ ...v, telnet: capped(v.telnet, payload, tuning().telnetLogLimit) }))
      ),
      api.onLine(({ session: id, payload }) =>
        patchView(id, (v) => ({ ...v, lines: capped(v.lines, payload, tuning().lineLogLimit) }))
      ),
      // Facts, read two more ways. Nothing is asked of the server for either:
      // both are second views of the block feed the terminal already carries.
      api.onBlock(({ session: id, payload }) => {
        const conversation = payload.domain === 'conversation';
        // Cheap first: most lines are neither, and reaching into the character's
        // state for every one of them would put work on the block feed's hot
        // path for nothing.
        if (!conversation && !mayNotice(payload)) return;
        patchView(id, (v) => {
          /*
           * Inside the patch, because one notice depends on who threw the
           * punch: a blow from a monster is the weather, and the same blow from
           * a *player* opens the five-minute window in which hanging up kills.
           * The roster that tells them apart is on the view being patched.
           */
          const raised = wanted(alertsRef.current, [noticeFor(payload, t, v.character)]);
          return {
            ...v,
            talk: conversation ? capped(v.talk, payload, tuning().talkLimit) : v.talk,
            notices: raised.reduce(
              (log, notice) => capped(log, notice, tuning().noticeLimit),
              v.notices
            ),
            unseen: missed(v.unseen, raised, shownRef.current.has(id))
          };
        });
      }),
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
  }, [api, patchView]);

  /*
   * The roster is pushed on `clientReady`, but a window that reloads can listen
   * a moment later than the push. Asking once closes that window; the push
   * keeps it current afterwards.
   */
  useEffect(() => {
    void api.listSessions().then(setSessions);
  }, [api]);

  /*
   * A character is step one; there is no "before you have one".
   *
   * With no characters there is no session and no console, so the client's only
   * job is to help make one — and the way in is the new-character form, opened
   * here rather than described in a notice somebody has to find. Once per
   * launch: closing the form is a choice, and reopening it on every profile
   * push would take that choice away. The anonymous session this replaced was
   * retired 2026-08-29 (see `NO_SESSION`).
   */
  const offeredFirstCharacter = useRef(false);
  useEffect(() => {
    if (!profilesKnown || profiles.length > 0 || sessions.length > 0) return;
    if (offeredFirstCharacter.current) return;
    offeredFirstCharacter.current = true;
    setSettingsAt(SETTINGS_NEW_CHARACTER);
    setSettingsOpen(true);
  }, [profilesKnown, profiles, sessions]);

  /**
   * The HUD appears on its own, without the diagnostics rail.
   *
   * Vitals and Room are what the player reads while playing; putting them
   * behind a toggle labelled "diagnostics" meant they were never seen. The rail
   * is therefore present whenever there is *either* HUD content or diagnostics
   * to show, and each half decides for itself.
   */
  /**
   * Whether the Navigation card is still worth the space it takes.
   *
   * A walk or a loop in progress always is. A *finished* walk is news for a
   * moment and clutter after it — and the card sits above the rest of the
   * rail, so it moves everything below it for as long as it stays.
   * `clearAfterSeconds: 0` keeps it, for anyone who would rather dismiss it
   * themselves.
   */
  const [walkStale, setWalkStale] = useState(false);
  const finished = walk.status === 'arrived' || walk.status === 'stopped';
  const clearAfter = config.automation.walk.clearAfterSeconds;

  useEffect(() => {
    setWalkStale(false);
    if (!finished || clearAfter <= 0) return;
    // Keyed on the outcome as well as the status, so a second walk that ends
    // the same way still gets its own moment on screen.
    const timer = window.setTimeout(() => setWalkStale(true), clearAfter * 1000);
    return () => window.clearTimeout(timer);
  }, [finished, clearAfter, walk.reason, walk.destination, walk.done]);

  /*
   * Either half is reason enough, because they are one card.
   *
   * The walk half fades once it has been finished for `clearAfterSeconds`. The
   * loop half is a set of *controls*, so it shows while there is something to
   * control: a loop running, paused or just stopped, or a character in the
   * realm with loops of its own to start. With neither half the card is chrome,
   * and null.
   *
   * One test rather than two, because two would let the card appear for one
   * face and disappear for the other — which on a rail is every control below
   * it moving while somebody reaches for one.
   */
  const navigationVisible =
    (walk.status !== 'idle' && !walkStale) ||
    view.loop.status !== 'idle' ||
    (character.phase === 'in-game' && loops.length > 0);

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
  const railVisible = hudOpen || railOpen;

  const connected = state.phase === 'connected';
  const busy = state.phase === 'connecting' || state.phase === 'closing';

  /**
   * Dial the character being shown.
   *
   * No address: where a character connects is a property of the character, and
   * it lives in that character's file. A target is passed only by the palette's
   * saved-server entries, which are the ad-hoc path.
   */
  const dial = useCallback(
    (id: SessionId, target?: ConnectionTarget) => {
      // Only this character's history: a reconnect on one must not wipe what
      // the tab rail is reporting about the others.
      patchView(id, (v) => ({ ...v, telnet: [], lines: [], character: EMPTY_CHARACTER }));
      // The throughput meter reads the character on screen, so it is cleared
      // only when that is the one being dialled — a reconnect on an unattended
      // character must not blank the readout for the one being watched.
      if (id === activeRef.current) reset();
      void api.connect(id, target);
    },
    [api, patchView, reset]
  );

  const hangUp = useCallback((id: SessionId) => void api.disconnect(id), [api]);

  const handleConnect = useCallback(
    (target?: ConnectionTarget) => dial(session, target),
    [dial, session]
  );

  const handleDisconnect = useCallback(() => hangUp(session), [hangUp, session]);

  /**
   * Dial or hang up a character from its own tab.
   *
   * Addressed, and deliberately not `toggleConnection`: the rail reports on the
   * characters nobody is looking at, so the one being connected is usually not
   * the one on screen — and a button that quietly acted on the *shown*
   * character would disconnect the wrong one, which on this realm costs
   * something (docs/greatermud/combat.md).
   *
   * Refused while a dial or a close is already in flight. `connect()` in main
   * refuses a second attempt itself, so this is about the button rather than
   * the socket: one that stays pressable through a fifteen-second dial reads as
   * one that did nothing.
   */
  const toggleSessionConnection = useCallback(
    (id: SessionId) => {
      const phase = views[id]?.state.phase ?? 'idle';
      if (phase === 'connecting' || phase === 'closing') return;
      /*
       * **A retry pending counts as connected for this button**, because the
       * question it answers is *is something dialling this character* and
       * during a ladder's wait the phase is `closed`. Without it the dial
       * offered Connect while a reconnect ran to its 999,999th attempt, and
       * nothing anywhere in the client meant *stop trying* — with a bad
       * password going out every fifteen seconds if the realm hangs up on one.
       */
      if (phase === 'connected' || (sessions.find((s) => s.id === id)?.retrying ?? false)) {
        hangUp(id);
      } else dial(id);
    },
    [dial, hangUp, sessions, views]
  );

  /**
   * Show a different character.
   *
   * Sends nothing. The state is already here — every character's facts arrive
   * whether or not its terminal is on screen — so a switch is a change of view
   * and never a command. A bare Enter to "refresh" would be a command the player
   * did not type, and in this game a bare Enter is a full room description that
   * re-triggers everything listening for one.
   */
  const showSession = useCallback(
    (id: SessionId) => {
      // Already on screen? Then this is a request to type at it, not to move it.
      const at = panes.indexOf(id);
      if (at >= 0) {
        setFocusedPane(at);
        return;
      }
      setPaneIds(panes.map((current, index) => (index === paneAt ? id : current)));
    },
    [paneAt, panes]
  );

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

  const stepSession = useCallback(
    (delta: number) => {
      if (sessions.length < 2) return;
      const at = sessions.findIndex((entry) => entry.id === session);
      const next = sessions[(at + delta + sessions.length) % sessions.length];
      if (next) showSession(next.id);
    },
    [session, sessions, showSession]
  );

  /** The element the panes divide, so a split can be measured before it is made. */
  const layersRef = useRef<HTMLDivElement | null>(null);

  /**
   * How many columns each pane would get if the slate were divided `count` ways
   * side by side.
   *
   * Arithmetic on a *measured* cell width, never on a constant. There is no
   * minimum-pane-width in pixels anywhere in this path and there cannot be:
   * display scaling differs per user, a window can be dragged to a monitor with
   * another scale factor, and the terminal font size is a setting. The live
   * terminal's own geometry is the only honest source for what a column costs.
   *
   * A prediction only — once the split lands each pane measures itself for real
   * and reality wins. This exists to avoid making the mess, not to be believed
   * afterwards.
   */
  const columnsIfSplit = useCallback(
    (count: number): number | null => {
      const box = layersRef.current;
      if (!box || size.cols <= 0) return null;
      const cell = box.clientWidth / size.cols;
      if (!Number.isFinite(cell) || cell <= 0) return null;
      // The gaps between panes are not available to any of them.
      const gap = 8 * (count - 1);
      return Math.floor((box.clientWidth - gap) / count / cell);
    },
    [size.cols]
  );

  /**
   * The one gate on going side by side: predicts the split, and when each
   * console would fall under the floor, prints the caller's refusal into the
   * shown terminal. True means refused, so the caller stands down. Shared by
   * `addPane` and `turnPanes` because the arithmetic and the reporting must
   * not drift apart — only the remedy clause differs.
   */
  const refuseNarrowSplit = useCallback(
    (count: number, message: (columns: number) => string): boolean => {
      const predicted = columnsIfSplit(count);
      if (predicted === null || predicted >= MIN_COLUMNS) return false;
      terminals.current.get(session)?.notice(message(predicted));
      return true;
    },
    [columnsIfSplit, session]
  );

  /**
   * Put another character on screen beside this one.
   *
   * Refused when the slate cannot carry it side by side, with the only two
   * remedies there are: stack instead, or use a smaller terminal font. There is
   * no third — the server never negotiates NAWS, so "tell it we are narrower"
   * is not a thing that exists.
   */
  const addPane = useCallback(
    (id: SessionId) => {
      if (panes.length >= tuning().maxPanes || panes.includes(id)) return;

      if (
        paneFlow === 'columns' &&
        refuseNarrowSplit(panes.length + 1, (columns) =>
          t('notices.panes.splitTooNarrowStack', { columns, minColumns: MIN_COLUMNS })
        )
      ) {
        return;
      }

      setPaneIds([...panes, id]);
      setFocusedPane(panes.length);
    },
    [paneFlow, panes, refuseNarrowSplit]
  );

  /**
   * Turn the split, if the slate can carry it.
   *
   * Guarded for the same reason `addPane` is, and it is the same gate: asking
   * for side by side is a deliberate action, so it is refused with a reason
   * rather than granted and then complained about. Turning *back* to stacked is
   * always allowed — it can only ever give a console more room.
   *
   * This is not the same case as a split that drifts under the floor because
   * the window was dragged narrower. That one is reported and never corrected:
   * a layout that reorganises itself under someone's hands mid-combat is a
   * hazard, and the status rail says `narrow` instead.
   */
  const turnPanes = useCallback(
    (next: PaneFlow) => {
      if (
        next === 'columns' &&
        panes.length > 1 &&
        refuseNarrowSplit(panes.length, (columns) =>
          t('notices.panes.splitTooNarrowKeep', { columns, minColumns: MIN_COLUMNS })
        )
      ) {
        return;
      }
      setPaneFlow(next);
    },
    [panes.length, refuseNarrowSplit, setPaneFlow]
  );

  const closePane = useCallback(() => {
    if (panes.length < 2) return;
    setPaneIds(panes.filter((_, index) => index !== paneAt));
    setFocusedPane(Math.max(0, paneAt - 1));
  }, [paneAt, panes]);

  const focusPane = useCallback(
    (id: SessionId) => {
      const at = panes.indexOf(id);
      if (at >= 0) setFocusedPane(at);
    },
    [panes]
  );

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
        if (refused) {
          terminals.current
            .get(id)
            ?.notice(t('notices.session.closeRefused', { refusalReason: refused }));
        }
      });
    },
    [api]
  );

  /**
   * @param movesFocus Set by a command that is taking focus somewhere itself;
   *   every other route out of the palette hands it back to the terminal.
   */
  const closePalette = useCallback(
    (movesFocus = false) => {
      setPaletteOpen(false);
      if (!movesFocus) returnFocus();
    },
    [returnFocus]
  );

  const togglePalette = useCallback(() => {
    if (paletteOpen) closePalette();
    else setPaletteOpen(true);
  }, [paletteOpen, closePalette]);

  /*
   * The Loops modal, which holds the caret while it is open and hands it back
   * on every exit — a surface that takes typed input, like the palette, and
   * unlike the diagnostics rail.
   */
  const closeLoops = useCallback(() => {
    setLoopsOpen(false);
    returnFocus();
  }, [returnFocus]);

  /*
   * Only for a character that exists.
   *
   * Everything the modal does is addressed at one: it files into that
   * character's scope, starts a loop on its session and reports a refusal into
   * its console. With `NO_SESSION` there is no console for the refusal to
   * reach, so the whole gesture would fail in silence — which is the one
   * outcome "say it out loud" forbids. A client with no characters has one
   * job, and it is not this.
   */
  const toggleLoops = useCallback(() => {
    if (loopsOpen) closeLoops();
    else if (session !== NO_SESSION) setLoopsOpen(true);
  }, [loopsOpen, closeLoops, session]);

  /*
   * And it goes away if the character does while it is open.
   *
   * Guarding only the *opening* leaves the modal up when the last tab is
   * closed or a profile file is deleted — `session` becomes `NO_SESSION`
   * underneath it, and every row then addresses nobody. Nothing is written
   * wrongly (main refuses an absent owner, and `startLoop` finds no session),
   * but the refusals are spoken into a console that does not exist, so a click
   * would do nothing and say nothing. A guard on entry and none on the state
   * is half a rule.
   */
  useEffect(() => {
    if (loopsOpen && session === NO_SESSION) closeLoops();
  }, [loopsOpen, session, closeLoops]);

  /**
   * The rail takes no typed input, so opening it leaves focus in the terminal
   * and there is nothing to hand back on close.
   */
  const toggleRail = useCallback(() => setRailOpen((open) => !open), []);

  /**
   * Search is a dialog that takes typed input, so closing it hands focus back
   * to the terminal — the same contract the palette honours.
   */
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchResult(undefined);
    activeTerminal()?.search('', 'next');
    returnFocus();
  }, [activeTerminal, returnFocus]);

  const toggleSearch = useCallback(() => {
    if (searchOpen) closeSearch();
    else setSearchOpen(true);
  }, [searchOpen, closeSearch]);

  const runSearch = useCallback(
    (query: string, direction: 'next' | 'previous') => {
      activeTerminal()?.search(query, direction);
    },
    [activeTerminal]
  );

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
      revealConfig: () => void api.revealConfig(),
      revealProfiles: () => void api.revealProfiles(),
      chooseRealm: () => api.chooseRealm(),
      // The shelf of shipped loops, for the Movement tab. Asked for when
      // that picker opens rather than with the snapshot: four hundred
      // loops, and most visits to that screen are about a password.
      loadLoops: () => api.loopCatalogue()
    }),
    [api]
  );

  /**
   * Settings is a form, so it hands the keyboard back to the game on the way
   * out — Escape, the close button, or a click on the scrim. The one surface
   * that holds the caret while a character is standing somewhere is the one
   * that has to be reliable about giving it back.
   */
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    returnFocus();
  }, [returnFocus]);

  /** Open settings wherever it was — the palette and the shortcut. */
  const openSettings = useCallback(() => {
    setSettingsAt(null);
    setSettingsOpen(true);
  }, []);

  /** Open settings on one named character — a tab's own menu. */
  const editCharacter = useCallback((id: SessionId) => {
    setSettingsAt(id);
    setSettingsOpen(true);
  }, []);

  /** Open settings on an empty character — the `+` at the head of the rail. */
  const newCharacter = useCallback(() => {
    setSettingsAt(SETTINGS_NEW_CHARACTER);
    setSettingsOpen(true);
  }, []);

  /** Open settings straight to the servers list — the palette's own way in. */
  const manageServers = useCallback(() => {
    setSettingsAt(SETTINGS_MANAGE_SERVERS);
    setSettingsOpen(true);
  }, []);

  /**
   * Open settings on the client's own — the gear at the head of the tab rail.
   *
   * Beside the `+` because that is where somebody already is when they want to
   * change something about the client rather than about a character, and
   * because a settings screen reachable only by a chord is one most people
   * never find. Also in the palette, for the same reason.
   */
  const editGlobal = useCallback(() => {
    setSettingsAt(SETTINGS_GLOBAL);
    setSettingsOpen(true);
  }, []);

  /** And the other half of that file: what a new realm and character start with. */
  const editDefaults = useCallback(() => {
    setSettingsAt(SETTINGS_DEFAULTS);
    setSettingsOpen(true);
  }, []);

  /** Route planning is a dialog that types, so it hands focus back on close. */
  const closeRoute = useCallback(() => {
    setRouteOpen(false);
    returnFocus();
  }, [returnFocus]);

  // Addressed: this character's realm, not the client's.
  const searchRooms = useCallback(
    (query: string) => api.searchRooms(session, query),
    [api, session]
  );
  const walkRoute = useCallback((route: Route) => api.walkRoute(session, route), [api, session]);

  /**
   * Every room the palette's query reaches, as rows that walk there.
   *
   * The palette used to search one flat list of the client's own commands, so
   * the one thing somebody types a place name into a search box wanting — to go
   * there — was the one thing it could not answer. `Ctrl/Cmd K`, `1 297` or
   * `bank of god`, Enter, and the character is walking.
   *
   * **This is the one path that walks without the plan being read first**, and
   * it is deliberate rather than an oversight of the rule the map click keeps.
   * The difference is what was chosen: a map click is a click on a picture, and
   * the easiest possible way to send a character somewhere by accident; this
   * row was typed, read and picked out of a list that names the room and its
   * reference. What cannot be walked still opens the panel — a blocked route
   * has conditions to read, and a refusal has a reason — so nothing silently
   * fails, and `walk:stop` is a keystroke away either way.
   *
   * The rows are `transient`: they exist for as long as the query, and a shelf
   * entry naming one would be a row nobody could reach from the shelf.
   */
  const findRooms = useCallback(
    async (query: string): Promise<Command[]> => {
      const rooms = await api.searchRooms(session, query);
      const now = Date.now();
      return rooms.map((room) => ({
        id: `goto:${roomId(room.map, room.room)}`,
        icon: 'route' as const,
        transient: true,
        label: t('palette.navigate.gotoLabel', { roomName: room.name }),
        /*
         * A room already walked to says so, and says when.
         *
         * Main puts the recent ones on top; without the hint saying which they
         * are, the reordering is invisible and reads as the realm answering in
         * a different order each time. The id stays on the row either way --
         * it is how two rooms of the same name are told apart, and dropping it
         * for the very rows most likely to be duplicates would be backwards.
         */
        hint:
          room.visitedAt === null
            ? roomId(room.map, room.room)
            : t('palette.navigate.gotoVisitedHint', {
                roomReference: roomId(room.map, room.room),
                agoText: ago(room.visitedAt, now)
              }),
        run: () => {
          void api
            .routeTo(session, room.map, room.room)
            .then(async (route) => {
              // Nothing to walk, or nothing that *can* be walked: the panel is
              // where a blocked route states its conditions and where a room
              // already stood in says so. Opening it is the honest answer, and
              // it is the same surface every other room click reaches.
              if (route.blocked || route.steps.length === 0) return route;
              const refusal = await api.walkRoute(session, route);
              return refusal === null ? null : route;
            })
            .then((unwalked) => {
              if (unwalked === null) return;
              setRouteTarget(room);
              setRouteSearch(null);
              setRouteOpen(true);
            })
            .catch(() => {
              // A route that could not be planned at all: the panel says why,
              // rather than a click that does nothing.
              setRouteTarget(room);
              setRouteSearch(null);
              setRouteOpen(true);
            });
        }
      }));
    },
    [api, session]
  );
  /*
   * `radius` is optional and passed straight through: the Map card measures
   * its own box and asks for what it can show, while the route panel — whose
   * map is a fixed strip in a fixed panel — takes main's default.
   */
  const loadMap = useCallback(
    (map: number, room: number, radius?: number) => api.localMap(session, map, room, radius),
    [api, session]
  );
  /** Who this character is, for deciding what the pack may put on. */
  const loadWearer = useCallback(() => api.wearer(session), [api, session]);
  const lookupName = useCallback((query: string) => api.lookup(session, query), [api, session]);
  /**
   * A name clicked on a card, asking what the realm knows about it.
   *
   * Opens a slide-out beside the name rather than a card on the rail: the
   * person wants to read and put it away, and a card somewhere else on the
   * screen is the wrong shape for that. Stamped so the same name clicked
   * twice still lands; the second click replaces the first panel.
   */
  const inspect = useCallback((name: string, anchor: HTMLElement) => {
    setFlyout(null);
    setGangFlyout(null);
    setAsked({ name, anchor });
  }, []);
  const dismissAsked = useCallback(() => setAsked(null), []);
  /** A probe asked for from a card, through the arbiter. */
  const ask = useCallback(
    (command: string) => {
      void api.ask(session, command);
    },
    [api, session]
  );
  /**
   * A name clicked in the console. The console has no element to anchor to
   * — xterm paints cells — so it hands up the box of the cells instead.
   */
  const inspectAt = useCallback((name: string, anchor: PopoverAnchor) => {
    setFlyout(null);
    setGangFlyout(null);
    setAsked({ name, anchor });
  }, []);

  /**
   * A name clicked on a listing: open the Player flyout on that person, beside
   * the listing that was clicked.
   *
   * Addressed at the character whose card was clicked rather than at the shown
   * one, because a pinned float belongs to somebody else — the flyout reads
   * *that* character's registry and writes *that* character's permissions.
   * One slide-out at a time: opening this puts away the realm's answer about
   * an item, and vice versa, because two panels hanging off two names is two
   * things to put away and no way to tell which Escape means.
   */
  const selectPlayer = useCallback((sid: SessionId, name: string, anchor: PopoverAnchor) => {
    setAsked(null);
    setGangFlyout(null);
    setFlyout({ session: sid, name, anchor });
  }, []);
  const dismissFlyout = useCallback(() => setFlyout(null), []);

  /**
   * A gang clicked — in the console, or on the person whose gang it is.
   *
   * A gang is an entity like a person or an item: it is printed in the `who`
   * listing's own column, and it was the one recognisable thing on that line
   * that opened nothing. Addressed at the character whose surface was clicked,
   * because the membership is read out of *that* character's roster and
   * registry, and a pinned float belongs to somebody else.
   */
  const selectGang = useCallback((sid: SessionId, name: string, anchor: PopoverAnchor) => {
    setAsked(null);
    setFlyout(null);
    setGangFlyout({ session: sid, name, anchor });
  }, []);
  const dismissGangFlyout = useCallback(() => setGangFlyout(null), []);

  /**
   * A room's name clicked in the console: the route panel, on that room.
   *
   * The question about a room you are not standing in is *how do I get there*,
   * which is the panel the map and the Route face already open — so a room is
   * the one recognised name that does not answer with a readout.
   *
   * **A name is not an address.** The realm has 3,779 distinct room names over
   * 55,806 rooms, so most name several places — thirteen Town Gates, two Mossy
   * Tunnels — and picking one of them would be the guess this project refuses,
   * with a walk at the end of it. So the *name* goes to the panel and the panel
   * lists what it matched; a name matching exactly one room opens on that room,
   * which is what the search field there already does with a typed name.
   */
  const chooseRoomNamed = useCallback(
    (name: string) => {
      void api.searchRooms(session, name).then((rooms) => {
        // Exactly one room, and it is the one meant. Anything else — several
        // rooms sharing the name, or none — is left to the panel's own list
        // rather than resolved here, where there is nothing to show the reader.
        const exact = rooms.filter((room) => room.name.toLowerCase() === name.toLowerCase());
        const one = exact.length === 1 ? exact[0]! : null;
        setRouteTarget(one);
        // Several rooms share the name, or the realm has none: the panel opens
        // searching for it rather than on a room nobody chose.
        setRouteSearch(one === null ? name : null);
        setRouteOpen(true);
      });
    },
    [api, session]
  );
  /**
   * The people each character knows, for its console to recognise — the
   * registry and the roster, by the server's spelling. Keyed by value: a
   * state push arrives through structured clone, so the arrays are fresh
   * references per status line and the joined names are what stays equal.
   */
  const knownPlayersKey = useMemo(
    () =>
      Object.entries(views)
        .map(
          ([id, view]) =>
            `${id}\u0001${knownPlayerNames(view.character).join('\u0000')}\u0003${presentPlayerNames(view.character).join('\u0000')}`
        )
        .join('\u0002'),
    // Rebuilt when a state push lands, not on every render: the traversal is
    // every registry and every roster, and a card interaction is not news
    // about either.
    [views]
  );
  const knownPlayers = useMemo<Record<SessionId, { known: string[]; present: string[] }>>(() => {
    const out: Record<SessionId, { known: string[]; present: string[] }> = {};
    if (knownPlayersKey.length === 0) return out;
    const split = (names: string | undefined): string[] =>
      names === undefined || names.length === 0 ? [] : names.split('\u0000');
    for (const entry of knownPlayersKey.split('\u0002')) {
      const [id, lists] = entry.split('\u0001');
      if (id === undefined) continue;
      // Everyone known, then the ones in the realm now — see `NameIndex.setPlayers`.
      const [known, present] = (lists ?? '').split('\u0003');
      out[id as SessionId] = { known: split(known), present: split(present) };
    }
    return out;
  }, [knownPlayersKey]);
  /**
   * The gangs each character has heard of, folded the same way the people are.
   *
   * A joined string rather than an array of arrays, for the reason
   * `knownPlayersKey` is one: the memo below has to be keyed on the *contents*,
   * and a fresh array every render would rebuild the index on every status
   * line. The traversal is the roster and the registry, so it is done once here
   * rather than per hover.
   */
  const knownGangsKey = useMemo(
    () =>
      Object.entries(views)
        .map(([id, view]) => `${id}\u0001${knownGangs(view.character).join('\u0000')}`)
        .join('\u0002'),
    [views]
  );
  const gangsBySession = useMemo<Record<SessionId, string[]>>(() => {
    const out: Record<SessionId, string[]> = {};
    if (knownGangsKey.length === 0) return out;
    for (const entry of knownGangsKey.split('\u0002')) {
      const [id, list] = entry.split('\u0001');
      if (id === undefined) continue;
      out[id as SessionId] = list === undefined || list.length === 0 ? [] : list.split('\u0000');
    }
    return out;
  }, [knownGangsKey]);

  /**
   * Every name this character's realm knows, for the console to recognise.
   *
   * Once per realm rather than per hover: the list is a few thousand words
   * and the link provider is asked on every row the pointer crosses. Keyed on
   * the session because two characters may be on two realms.
   */
  const [names, setNames] = useState<Record<SessionId, WorldNames>>({});
  useEffect(() => {
    let live = true;
    for (const entry of sessions) {
      if (names[entry.id]) continue;
      void api.names(entry.id).then((found) => {
        if (live) setNames((current) => ({ ...current, [entry.id]: found }));
      });
    }
    return () => {
      live = false;
    };
  }, [api, names, sessions]);
  /**
   * The player striking a found way out, because it was not one.
   *
   * Main answers with the whole record over the same push that learning
   * uses, so every window showing the card sees the row go.
   */
  const forget = useCallback(
    (discovery: { from: string; command: string }) => {
      void api.forget(session, discovery);
    },
    [api, session]
  );
  /**
   * A room clicked on the map opens the route panel with the plan already on
   * screen. It does not walk: a map click is the easiest possible way to send a
   * character somewhere by accident, so the steps still get read first.
   */
  const chooseOnMap = useCallback(
    (map: number, room: number) => {
      /*
       * Resolved before it opens. The panel's head states the realm's facts
       * about the destination -- its name, a shop, a lair, the exits -- and a
       * bare pair carries none, so the head used to open blank on this path.
       * A `map/room` query is answered by the index, exactly one room or
       * none; a room the realm does not have opens as the bare pair, which
       * the panel then reports rather than guessing at.
       */
      void api.searchRooms(session, `${map}/${room}`).then((rooms) => {
        const found = rooms.find((match) => match.map === map && match.room === room);
        setRouteTarget(found ?? { map, room, name: '', exits: [] });
        // A pair names exactly one room, so nothing is left ambiguous here —
        // and a name left over from an earlier click would seed the field
        // against the room this one settled.
        setRouteSearch(null);
        setRouteOpen(true);
      });
    },
    [api, session]
  );
  const stopWalk = useCallback(() => {
    void api.stopWalk(session);
    // The rail takes no typed input, so a click in it must not keep the caret:
    // stopping a walk is exactly the moment you want to be able to type.
    returnFocus();
  }, [api, returnFocus, session]);
  const stopLoop = useCallback(() => {
    // Stops the loop and the leg it was walking; main does both, because a
    // stopped walk under a live loop is a walk the loop would just restart.
    void api.stopLoop(session);
    returnFocus();
  }, [api, returnFocus, session]);
  /*
   * The loop face's other controls, each handing the caret back like every
   * click in the rail. A refusal — nothing paused, a plain loop asked to turn
   * round — is said in the console of the character it was about, the same
   * way the palette's loop command reports one.
   */
  const sayRefusal = useCallback(
    (sid: SessionId) => (refused: string | null) => {
      if (refused) terminals.current.get(sid)?.notice(refused);
    },
    []
  );
  /**
   * Start a loop chosen from the modal, and keep it where the player said.
   *
   * **Filed first, then started, and the order is not an accident.**
   * `loop:start` resolves a name against the character's *own* resolved
   * options, which is the same list the palette and the card start from — a
   * loop that has never been written into a scope this character reads is a
   * name main answers `notFound` to. So the write has to land, and the store
   * has to have re-read it, before the start is asked for.
   *
   * `Don't keep it` takes the other channel entirely: `loop:run` hands the
   * loop over whole, so nothing is written and nothing has to be cleaned up
   * afterwards. Filing one in order to start it and then deleting it would be
   * a write into the user's tree on the one path that promised not to make
   * one.
   *
   * **A row that is only *held* is already on disk and is started by name.**
   * `loop:list` reports one as a name and a stop *count*, never its stops, so
   * there is no loop to hand over and nothing to file — `loop:start` resolves
   * it exactly as the palette and the card do. The first version of this
   * invented empty stops to make such a row look like a shelf loop, and
   * `asLoops` then dropped them: the client refused the player's own
   * hand-written loop as one it could not file, which is a false claim about
   * their data as well as a loop that did not walk.
   *
   * Either way the outcome is said out loud in the character's own console —
   * a loop quietly filed somewhere is a file somebody finds a fortnight later
   * with no memory of asking for it.
   */
  const runChosenLoop = useCallback(
    (choice: LoopChoice, destination: LoopDestination) => {
      const say = sayRefusal(session);
      const said = (message: string) => terminals.current.get(session)?.notice(message);

      void (async () => {
        // Already on disk: nothing to write, whatever the destination says.
        if (choice.kind === 'by-name') {
          const refused = await api.startLoop(session, choice.name);
          say(refused);
          if (refused === null) said(t('loops.startedKept', { loopName: choice.name }));
          return;
        }

        const { loop } = choice;
        if (destination === 'none') {
          const refused = await api.runLoop(session, loop);
          say(refused);
          if (refused === null) said(t('loops.startedOnly', { loopName: loop.name }));
          return;
        }

        const owner =
          destination === 'server'
            ? (profiles.find((profile) => profile.id === session)?.serverName ?? null)
            : session;
        const refused = await api.addLoop(destination, owner, loop);
        if (refused !== null) {
          say(refused);
          return;
        }
        const started = await api.startLoop(session, loop.name);
        say(started);
        if (started === null) said(t('loops.startedKept', { loopName: loop.name }));
      })();
    },
    [api, profiles, sayRefusal, session]
  );

  const startLoop = useCallback(
    (name: string) => {
      void api.startLoop(session, name).then(sayRefusal(session));
      returnFocus();
    },
    [api, returnFocus, sayRefusal, session]
  );
  const pauseLoop = useCallback(() => {
    void api.pauseLoop(session);
    returnFocus();
  }, [api, returnFocus, session]);
  const resumeLoop = useCallback(() => {
    void api.resumeLoop(session).then(sayRefusal(session));
    returnFocus();
  }, [api, returnFocus, sayRefusal, session]);
  const skipLoop = useCallback(() => {
    void api.skipLoopStop(session).then(sayRefusal(session));
    returnFocus();
  }, [api, returnFocus, sayRefusal, session]);
  const reverseLoop = useCallback(() => {
    void api.reverseLoop(session).then(sayRefusal(session));
    returnFocus();
  }, [api, returnFocus, sayRefusal, session]);
  const routeTo = useCallback(
    (room: { map: number; room: number }) => api.routeTo(session, room.map, room.room),
    [api, session]
  );

  const toggleConnection = useCallback(() => {
    if (connected) handleDisconnect();
    else handleConnect();
  }, [connected, handleConnect, handleDisconnect]);

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

  /*
   * Everyone this character can ask, by name: the roster, then anybody the
   * registry still holds as online, minus this character.
   *
   * Memoised by **value**, in two steps. `character` is republished on every
   * status line and arrives over IPC through structured clone, so
   * `character.online` and `character.players` are fresh references each time
   * and a memo keyed on them recomputes per line — which would then rebuild
   * the forty-odd commands below per line, the churn this exists to absorb.
   * The first memo reduces the names to one string; the second keys on that
   * string, and a string compares by value, so the array below keeps its
   * identity for as long as the names do.
   */
  const askableKey = useMemo<string>(() => {
    const self = character.name?.toLowerCase() ?? null;
    const names = new Map<string, string>();
    for (const entry of character.online) names.set(entry.name.toLowerCase(), entry.name);
    for (const record of Object.values(character.players)) {
      if (record.online) names.set(record.name.toLowerCase(), record.name);
    }
    if (self !== null) names.delete(self);
    return [...names.values()].sort((a, b) => a.localeCompare(b)).join('\u0000');
  }, [character.name, character.online, character.players]);
  const askable = useMemo<string[]>(
    () => (askableKey.length === 0 ? [] : askableKey.split('\u0000')),
    [askableKey]
  );

  /*
   * Each character's connection phase, memoised by **value** the way
   * `askable` is and for its reason: the palette's commands read only the
   * phase out of `views`, and listing `views` itself as a dependency rebuilt
   * the whole command list — a few hundred objects — on every state flush,
   * which on a busy realm is several times a second. The string changes when
   * a phase does and not otherwise.
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
   * The console's own index, per character, for the cards that quote the
   * server's sentences: built when the realm's names arrive and re-fed the
   * people when they change, so a card and the console cannot disagree about
   * what is a name. `knownPlayers` is value-keyed, so this reruns when the
   * people change and not on every status line.
   */
  const realmIndexes = useMemo<Record<SessionId, NameIndex>>(() => {
    const out: Record<SessionId, NameIndex> = {};
    for (const [id, found] of Object.entries(names)) out[id as SessionId] = new NameIndex(found);
    return out;
  }, [names]);
  /*
   * The people change while the realm's names do not — every arrival and
   * departure, against a realm index of thousands of names that is built
   * once — so they are set onto each index in place rather than the index
   * being rebuilt. The same objects go to the console and to the cards, which
   * is what makes "the console's own index" literally true rather than two
   * instances fed the same inputs.
   */
  const nameIndexes = useMemo<Record<SessionId, NameIndex>>(() => {
    for (const [id, index] of Object.entries(realmIndexes)) {
      const people = knownPlayers[id as SessionId];
      index.setPlayers(people?.known ?? [], people?.present ?? []);
      // Set in place beside the people and for the same reason: a gang changes
      // when a `who` lands, and the realm's thousands of names do not.
      index.setGangs(gangsBySession[id as SessionId] ?? []);
    }
    return realmIndexes;
  }, [realmIndexes, knownPlayers, gangsBySession]);

  const commands = useMemo<Command[]>(
    () => [
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
        run: openSettings
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
        run: manageServers
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
        run: editGlobal
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
        run: editDefaults
      },
      {
        id: 'connection',
        icon: connected ? ('stop' as const) : ('play' as const),
        label: connected
          ? t('palette.character.disconnectLabel')
          : t('palette.character.connectLabel'),
        // Named, because with several characters loaded "connect" is ambiguous
        // and the answer is always "the one you are looking at".
        hint: `${sessions.find((e) => e.id === session)?.name ?? session} · ${chord('Enter')}`,
        group: 'character',
        run: toggleConnection
      },
      // Saved realms, so the common case is not retyping a host and port.
      ...config.servers.map((server) => ({
        id: `server:${server.name}`,
        icon: 'play' as const,
        label: t('palette.character.connectRealmLabel', { realmName: server.name }),
        hint: `${server.host}:${server.port}`,
        group: 'character' as const,
        run: () => handleConnect(targetFromServer(server))
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
              run: () => showSession(entry.id)
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
              label: t('palette.character.closeLabel', {
                characterName: sessions.find((e) => e.id === session)?.name ?? session
              }),
              hint: connected ? t('palette.character.closeDisconnectFirstHint') : undefined,
              group: 'character' as const,
              run: () => closeSession(session)
            },
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
             */
            {
              id: 'popout',
              icon: 'popout' as const,
              label: t('palette.character.popoutLabel', {
                characterName: sessions.find((e) => e.id === session)?.name ?? session
              }),
              hint: sessions.length > 1 ? undefined : t('palette.character.popoutOnlyHint'),
              group: 'character' as const,
              movesFocus: true,
              run: () => {
                void api.popOut(session).then((refused) => {
                  if (refused !== null) activeTerminal()?.notice(refused);
                });
              }
            },
            {
              id: 'popin',
              icon: 'popin' as const,
              label: t('palette.character.popinLabel', {
                characterName: sessions.find((e) => e.id === session)?.name ?? session
              }),
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
        run: () => {
          setRouteTarget(null);
          // Opened cold from the palette: neither a room nor a name is meant,
          // so a seed left by an earlier console click does not survive.
          setRouteSearch(null);
          setRouteOpen(true);
        }
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
        run: () => setSearchOpen(true)
      },

      /*
       * A question for another player, by name. `Remotes.ask` was
       * reachable only from a party forming; *"ask somebody for their health"*
       * is the ordinary way a person would use it, and a command nobody can
       * find does not exist. One command per person this character knows to
       * be in the realm — the roster and the registry's online records — the
       * way a loop or a realm is one command each: findable by typing the
       * name, and never a picker to learn. Not this character itself, whose
       * numbers are on its own card.
       *
       * Three things here name the same character and must go on doing so:
       * the names come from `character`, the ask is addressed to `session`,
       * and the refusal lands in `terminals.current.get(session)` — all the
       * shown one. A split pane that showed another character's roster here
       * would have to move all three together, or ask on the wrong character's
       * behalf; the Player flyout's rule ("addressed at the character whose
       * listing was clicked") is the shape to copy then.
       */
      ...askable.map((name) => ({
        id: `remote:health:${name.toLowerCase()}`,
        icon: 'user' as const,
        label: t('palette.character.askHealthLabel', { name }),
        keywords: ['ask', 'health', '@health', 'remote', 'party', name],
        group: 'character' as const,
        run: () => {
          void api.askRemote(session, name, 'health').then((sent) => {
            if (!sent)
              terminals.current
                .get(session)
                ?.notice(t('palette.character.askHealthRefused', { name }));
          });
        }
      })),

      // View: how the client presents itself, rather than what it is doing.
      {
        id: 'rail',
        icon: 'activity' as const,
        label: railOpen
          ? t('palette.view.hideDiagnosticsLabel')
          : t('palette.view.showDiagnosticsLabel'),
        hint: chord('D', true),
        group: 'view',
        run: toggleRail
      },
      {
        id: 'jump',
        icon: 'jumpDown' as const,
        label: t('palette.view.jumpLabel'),
        hint: chord('L', true),
        group: 'view',
        run: () => activeTerminal()?.jumpToLatest()
      },
      {
        id: 'hud',
        icon: 'layout' as const,
        label:
          hudPreference === 'on'
            ? t('palette.view.hideCardsLabel')
            : t('palette.view.showCardsLabel'),
        hint: inGame ? undefined : t('palette.view.hudNotInRealmHint'),
        group: 'view',
        keywords: ['hud', 'cards', 'rail', 'panel'],
        run: () => setHudPreference(hudPreference === 'on' ? 'off' : 'on')
      },
      {
        id: 'density',
        icon: 'density' as const,
        label: t('palette.view.densityLabel'),
        hint: preference === 'auto' ? t('palette.view.densityAutoHint', { density }) : density,
        group: 'view',
        keywords: ['density', 'compact', 'comfortable', 'spacing', 'size'],
        run: cycle
      },
      {
        id: 'focus',
        icon: 'terminal' as const,
        label: t('palette.view.focusLabel'),
        group: 'view',
        keywords: ['focus', 'terminal', 'console', 'caret', 'cursor'],
        run: () => activeTerminal()?.focus()
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
        run: toggleLoops
      },
      // Loops: the loop a character walks to gain levels. Asked of the
      // session rather than read off the global config, because a profile
      // overlay replaces `automation.loops` — the global list is the wrong
      // answer for any character that states its own.
      ...loops.map((loop) => ({
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
            if (refused) terminals.current.get(session)?.notice(refused);
          });
        }
      })),
      // Only while a loop is actually running: a stop for a loop that is
      // not looping is a control that does nothing, which is worse than none.
      ...(view.loop.status === 'running'
        ? [
            {
              id: 'loop:stop',
              icon: 'stop' as const,
              label: t('palette.navigate.loopStopLabel'),
              hint: t('palette.navigate.loopStopHint'),
              keywords: ['loop', 'stop', 'halt'],
              group: 'navigate' as const,
              run: () => void api.stopLoop(session)
            }
          ]
        : []),
      {
        id: 'theme',
        icon: 'theme' as const,
        label: t('palette.view.themeCycleLabel'),
        hint:
          themePreference === 'system'
            ? t('palette.view.themeCycleSystemHint', { themeLabel: theme.label })
            : theme.label,
        group: 'view',
        run: cycleTheme
      },
      // One command per theme, so a theme is *chosen* rather than cycled to
      // through fifteen others. Findable by its own name and by "theme".
      ...THEME_PREFERENCES.filter((entry) => entry !== themePreference).map((entry) => ({
        id: `theme:${entry}`,
        icon: 'theme' as const,
        label:
          entry === 'system'
            ? t('palette.view.themeFollowSystemLabel')
            : t('palette.view.themeLabel', { themeLabel: THEMES[entry].label }),
        hint: entry === 'system' ? t('palette.view.themeSystemHint') : THEMES[entry].appearance,
        keywords: ['theme', 'colour', 'color', 'scheme', 'appearance'],
        group: 'view' as const,
        run: () => chooseTheme(entry)
      })),
      ...(showTabs
        ? [
            {
              id: 'tabside',
              icon: 'columns' as const,
              label:
                tabSide === 'top'
                  ? t('palette.view.tabsOnLeftLabel')
                  : t('palette.view.tabsOnTopLabel'),
              hint:
                tabSide === 'left' ? t('palette.view.tabsLeftHint') : t('palette.view.tabsTopHint'),
              group: 'view' as const,
              run: () => setTabSide(tabSide === 'top' ? 'left' : 'top')
            }
          ]
        : []),
      {
        id: 'config',
        icon: 'fileText' as const,
        label: t('palette.view.configLabel'),
        // The full path stretched the palette into a sideways scroll; the two
        // ends are what identify a path, so the middle is what goes.
        hint: shortPath(configPath),
        group: 'view',
        // `reveal` was the label until it stopped being one; somebody who
        // learned it should still find the row. A label is how a thing reads,
        // keywords are how it is found.
        keywords: ['reveal', 'open', 'yaml', 'file', 'folder', 'config', 'options'],
        run: () => void api.revealConfig()
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
        run: () => void api.revealProfiles()
      },
      {
        id: 'logs',
        icon: 'folder' as const,
        label: t('palette.view.logsLabel'),
        hint: config.logging.enabled ? undefined : t('palette.view.logsNotKeptHint'),
        group: 'view',
        keywords: ['reveal', 'open', 'folder', 'logs', 'records', 'transcript'],
        run: () => void api.revealLogs()
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
              run: () => addPane(entry.id)
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
              run: closePane
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
              run: () => turnPanes(paneFlow === 'rows' ? 'columns' : 'rows')
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
            hint: hides
              ? t('palette.layout.cardAlwaysHint')
              : t('palette.layout.cardHideEmptyHint'),
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
      // already knows they want it.
      ...(cards.floats.length > 0 || cards.away.length > 0
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
    ],
    /*
     * Everything the list is built from, and it has to be everything.
     *
     * `loops` and `view.loop.status` were both missing, and the fetch side was
     * healthy the whole time: `config:changed` bumps `loadedAt`, the `listLoops`
     * effect refires, main resolves the list live off the SessionManager, the
     * new list lands in state -- and this memo simply never reran. So an *added*
     * loop stayed absent until something unrelated forced a rebuild (switching
     * character, opening a pane), and a *removed* one lingered in the stale
     * array, still matching the shipped `loop:*` pattern and still drawn pinned.
     * There is no second source of truth to add here; `loop:list` was already
     * correct and already being asked.
     *
     * `widths` was missing for the same reason and nobody had reported it yet:
     * `layout:widths-reset` is offered only while some pane has been dragged off
     * its default, so the command appeared and disappeared a render late.
     * Listed by value rather than as the object, because `usePaneWidths` returns
     * a fresh literal every render -- depending on it would rebuild forty
     * commands per render and quietly turn this memo off.
     */
    [
      api,
      config.servers,
      sessions,
      profiles,
      showTabs,
      phases,
      cards,
      panes,
      paneFlow,
      turnPanes,
      addPane,
      closePane,
      session,
      showSession,
      closeSession,
      connected,
      tabSide,
      setTabSide,
      activeTerminal,
      config.logging.enabled,
      hudPreference,
      setHudPreference,
      inGame,
      configPath,
      handleConnect,
      railOpen,
      toggleRail,
      preference,
      density,
      cycle,
      theme,
      themePreference,
      cycleTheme,
      toggleConnection,
      openSettings,
      manageServers,
      editGlobal,
      editDefaults,
      loops,
      view.loop.status,
      askable,
      widths.rail,
      widths.tabs,
      widths.above,
      widths.below,
      widths.reset
    ]
  );

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
    {
      key: 'g',
      mod: true,
      run: () => {
        setRouteTarget(null);
        setRouteOpen((open) => !open);
      }
    },
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
    routeOpen &&
    !paletteOpen &&
    !loopsOpen &&
    !settingsOpen
      ? [{ key: 'Escape', run: closeRoute }]
      : []),
    ...(asked === null &&
    flyout === null &&
    searchOpen &&
    !paletteOpen &&
    !loopsOpen &&
    !routeOpen &&
    !settingsOpen
      ? [{ key: 'Escape', run: closeSearch }]
      : []),
    ...(asked === null &&
    flyout === null &&
    railOpen &&
    !paletteOpen &&
    !loopsOpen &&
    !searchOpen &&
    !routeOpen &&
    !settingsOpen
      ? [{ key: 'Escape', run: toggleRail }]
      : [])
  ]);

  /*
   * Read through refs by the cached bundles below, so a bundle built on the
   * first render cannot hold a stale flyout opener or refusal reporter.
   */
  const selectPlayerRef = useRef(selectPlayer);
  selectPlayerRef.current = selectPlayer;
  const sayRefusalRef = useRef(sayRefusal);
  sayRefusalRef.current = sayRefusal;

  /**
   * The addressed callbacks for one character, built once and kept.
   *
   * `contextFor` used to write these inline, which handed every card a fresh
   * function per prop per render — and a memoised card whose props never
   * compare equal is not memoised at all. Everything captured is either the
   * bridge and the id, which never change, or read through a ref.
   */
  const boundCache = useRef(new Map<SessionId, AddressedActions>());
  const boundFor = useCallback(
    (sid: SessionId): AddressedActions => {
      const cached = boundCache.current.get(sid);
      if (cached) return cached;
      const bound: AddressedActions = {
        ask: (command) => void api.ask(sid, command),
        forget: (discovery) => void api.forget(sid, discovery),
        gear: (action, item) => void api.gear(sid, action, item),
        loadWearer: () => api.wearer(sid),
        loadMap: (map, room, radius) => api.localMap(sid, map, room, radius),
        lookupName: (query) => api.lookup(sid, query),
        stopWalk: () => void api.stopWalk(sid),
        stopLoop: () => void api.stopLoop(sid),
        startLoop: (name) =>
          void api.startLoop(sid, name).then((refused) => sayRefusalRef.current(sid)(refused)),
        pauseLoop: () => void api.pauseLoop(sid),
        resumeLoop: () =>
          void api.resumeLoop(sid).then((refused) => sayRefusalRef.current(sid)(refused)),
        skipLoop: () =>
          void api.skipLoopStop(sid).then((refused) => sayRefusalRef.current(sid)(refused)),
        reverseLoop: () =>
          void api.reverseLoop(sid).then((refused) => sayRefusalRef.current(sid)(refused)),
        selectPlayer: (name, anchor) => selectPlayerRef.current(sid, name, anchor),
        setGangRemotes: (remotes) => void api.setGangRemotes(sid, remotes),
        setGangpath: (on) => void api.setRemoteGangpath(sid, on),
        setSupplies: (items) =>
          void api.setSupplies(sid, items).then((refused) => sayRefusalRef.current(sid)(refused)),
        send: (line) => void api.input(sid, `${line}\r`)
      };
      boundCache.current.set(sid, bound);
      return bound;
    },
    [api]
  );

  // A closed character's bundle must not linger for ever; the roster is the
  // authority on who is loaded.
  useEffect(() => {
    const keep = new Set(sessions.map((entry) => entry.id));
    for (const sid of boundCache.current.keys()) {
      if (!keep.has(sid)) boundCache.current.delete(sid);
    }
  }, [sessions]);

  /**
   * The supplies list and its writer as one object, kept for as long as the
   * list is.
   *
   * `contextFor` built `{ items, save }` inline, which handed the Self card
   * and the reference panel a fresh object on every render of the window —
   * and a memoised card whose props never compare equal is not memoised at
   * all. Measured with `npm run profile:ui` (2026-09-04): it was one of the
   * two props re-rendering a card on every commit, idle included.
   */
  const suppliesCache = useRef(
    new Map<
      SessionId,
      {
        items: SupplyItem[];
        save: AddressedActions['setSupplies'];
        bundle: { items: SupplyItem[]; save: AddressedActions['setSupplies'] };
      }
    >()
  );
  const suppliesBundle = useCallback(
    (sid: SessionId): { items: SupplyItem[]; save: AddressedActions['setSupplies'] } => {
      const items = suppliesFor(sid);
      const save = boundFor(sid).setSupplies;
      const cached = suppliesCache.current.get(sid);
      if (cached && cached.items === items && cached.save === save) return cached.bundle;
      const bundle = { items, save };
      suppliesCache.current.set(sid, { items, save, bundle });
      return bundle;
    },
    [boundFor, suppliesFor]
  );

  /**
   * Everything a card reads, addressed to one character.
   *
   * One builder for the shown character's cards and for another character's
   * pinned floats, so a field added for one cannot be forgotten for the other
   * — `view.loop` went stale in exactly that gap. The shown character keeps
   * the behaviours a float must not borrow: the route panel (it plans for the
   * shown realm), the throughput meter (it reports the character being
   * watched), the Navigation card's put-away timer, and the stop controls that hand
   * the caret back.
   *
   * Every function handed out here is identity-stable — the shown character's
   * own callbacks, or the cached bundle — because the cards are memoised. The
   * one exception is `toolbar`: its subject embeds live state and is rebuilt
   * per render, which is why `ToolbarCard` is deliberately not memoised.
   */
  const contextFor = useCallback(
    (sid: SessionId, v: SessionView, chrome: CardChrome): CardContext => {
      const shown = sid === session;
      const bound = boundFor(sid);
      return {
        session: sid,
        chrome,
        character: v.character,
        view: v,
        inGame: v.character.phase === 'in-game',
        thresholds: config.ui.vitals,
        navigationVisible: shown
          ? navigationVisible
          : v.walk.status !== 'idle' || v.loop.status !== 'idle',
        size,
        meter: shown ? meter : ZERO_METER,
        quiet: pressure === 'high',
        ask: shown ? ask : bound.ask,
        forget: shown ? forget : bound.forget,
        inspect,
        gear: bound.gear,
        loadWearer: shown ? loadWearer : bound.loadWearer,
        loadMap: shown ? loadMap : bound.loadMap,
        lookupName: shown ? lookupName : bound.lookupName,
        chooseOnMap: shown ? chooseOnMap : null,
        stopWalk: shown ? stopWalk : bound.stopWalk,
        stopLoop: shown ? stopLoop : bound.stopLoop,
        // The shown character's list is the only one the renderer holds; a
        // float's own loops are not asked for, so it offers no picker.
        loops: shown ? loops : null,
        startLoop: shown ? startLoop : bound.startLoop,
        pauseLoop: shown ? pauseLoop : bound.pauseLoop,
        resumeLoop: shown ? resumeLoop : bound.resumeLoop,
        skipLoop: shown ? skipLoop : bound.skipLoop,
        reverseLoop: shown ? reverseLoop : bound.reverseLoop,
        subject: flyout !== null && flyout.session === sid ? playerKey(flyout.name) : null,
        selectPlayer: bound.selectPlayer,
        /*
         * Addressed at `sid`, never at the shown character, for the reason
         * every other addressed field here is: a pinned float belongs to
         * somebody else, and a Gang card that wrote the shown character's
         * permissions would hand a stranger the wrong character's gang.
         */
        remotes: remotesFor(sid),
        setGangRemotes: bound.setGangRemotes,
        setGangpath: bound.setGangpath,
        supplies: suppliesBundle(sid),
        profileName: profileNameFor(sid),
        /*
         * Addressed like everything else here. A pinned float's toolbar
         * belongs to its own character — a master switch that turned
         * automation off on whoever happened to be on screen would be the
         * exact failure the tab rail's dial button records, applied to a row
         * of eight buttons at once.
         */
        toolbar: {
          switches: switchesFor(sid),
          connected: v.state.phase === 'connected',
          dialling: v.state.phase === 'connecting' || v.state.phase === 'closing',
          loop:
            v.loop.status === 'running'
              ? 'running'
              : v.loop.status === 'paused'
                ? 'paused'
                : 'idle',
          walking: v.walk.status === 'walking',
          /*
           * The same function main will run when the button is pressed, over
           * the same two facts — so a button that is lit is a button that will
           * do something, and one that is greyed is greyed because there is
           * nothing in the pack to put back.
           */
          canRestoreGear: canRestore(v.character.loadout, v.character.inventory.items),
          restoreGear: () => void api.gear(sid, 'restore'),
          setSwitch: (name, on) =>
            void api.setAutomationSwitch(sid, name, on).then(sayRefusal(sid)),
          connect: () => dial(sid),
          disconnect: () => hangUp(sid),
          pauseLoop: shown ? pauseLoop : () => void api.pauseLoop(sid),
          resumeLoop: shown ? resumeLoop : () => void api.resumeLoop(sid).then(sayRefusal(sid)),
          stopLoop: shown ? stopLoop : () => void api.stopLoop(sid),
          stopWalk: shown ? stopWalk : () => void api.stopWalk(sid),
          /*
           * The modal is the shown character's, like the route panel: it files
           * into a scope and starts a loop, and both are addressed at whoever
           * it was opened for. On a pinned float the button opens it for the
           * character on screen rather than for the float's own — so it is
           * `null` there and the button is not drawn, which is the rule a
           * control bound to nowhere already follows in this client.
           */
          openLoops: shown ? toggleLoops : null
        },
        // Per client, not per character: which buttons somebody keeps to hand
        // is a fact about the person at the keyboard, so every character's
        // toolbar draws the same row with its own answers on it.
        toolbarPinned: toolbarPins.pinned,
        pinToolbarButton: toolbarPins.toggle,
        nameIndex: nameIndexes[sid] ?? null,
        onSend: shown ? sayOnChannel : bound.send
      };
    },
    [
      api,
      ask,
      boundFor,
      meter,
      chooseOnMap,
      profileNameFor,
      suppliesBundle,
      config.ui.vitals,
      forget,
      inspect,
      loadWearer,
      loadMap,
      flyout,
      lookupName,
      pressure,
      remotesFor,
      switchesFor,
      toolbarPins,
      dial,
      hangUp,
      sayRefusal,
      sayOnChannel,
      selectPlayer,
      session,
      size,
      stopLoop,
      stopWalk,
      navigationVisible,
      loops,
      startLoop,
      pauseLoop,
      resumeLoop,
      skipLoop,
      reverseLoop,
      sayRefusal
    ]
  );

  /**
   * One card, wherever it is.
   *
   * The rail and the float layer render from the same function on purpose:
   * dragging a card out of the rail must not change what it *is*, and two
   * copies of this switch would drift the moment one of them gained a prop.
   * The chrome — close, drag handle, translucency — is assembled here too, so
   * every card gets the same set without listing it eleven times.
   *
   * Returns `null` for a card with nothing honest to say yet: a map of nowhere
   * and a walk that is not happening are cards that state nothing, which
   * docs/ui-design.md §3.2 does not allow.
   */
  /**
   * The chrome for a card, cached so its identity is stable across renders.
   *
   * Every card is memoised, and memoisation is only as good as the props: a
   * fresh `onClose` per render re-rendered every card per state flush, which
   * is the very cost the flush exists to avoid. The closures read the layout
   * and the drag machine through refs, so a cached handle never acts on a
   * stale layout; the object is rebuilt only when something a card *draws*
   * changes — dragging, floating, solidity, pinned — or when `returnFocus`
   * itself moves, the one captured value the refs do not cover: a cache that
   * kept the old one would hand the caret back through a stale closure for
   * the life of the window, with nothing failing.
   */
  const chromeCache = useRef(
    new Map<
      CardId,
      { key: string; focus: () => void; settings: CardSettings; chrome: CardChrome }
    >()
  );
  const chromeFor = useCallback(
    (id: CardId): CardChrome => {
      const floating = cardsRef.current.floatOf(id);
      const dragging = dragRef.current.state?.id === id && dragRef.current.state.live;
      // Which lane, and how tall it was dragged there: both part of the key,
      // because a card docked from a strip onto the rail gains the grip and a
      // resized one is drawn at its new height on the next commit, not later.
      const lane = cardsRef.current.laneOf(id);
      const height = cardsRef.current.heightOf(id);
      const key = floating
        ? `float:${floating.solidity}:${floating.pinned === true}:${dragging}:${theme.id}`
        : `rail:${dragging}:${theme.id}:${lane ?? ''}:${height ?? ''}`;
      /*
       * Compared by identity rather than folded into the string key. The store
       * hands back the very object it holds — the shared empty one for a card
       * nothing has been set on — and replaces it only for the card that
       * changed, so identity is exact. Spelling each field into the key would
       * be a list to keep in step with `CardSettings`, and the symptom of
       * forgetting one is a card that ignores a setting until something else
       * happens to invalidate its chrome.
       */
      const settings = cardsRef.current.settingsOf(id);
      const cached = chromeCache.current.get(id);
      if (
        cached &&
        cached.key === key &&
        cached.focus === returnFocus &&
        cached.settings === settings
      )
        return cached.chrome;
      const chrome: CardChrome = {
        cardId: id,
        onClose: () => cardsRef.current.hide(id),
        onGrab: (event: React.PointerEvent<HTMLElement>) => dragRef.current.begin(id, event),
        dragging,
        // Every card's copy menu takes the caret and gives it back here.
        returnFocus,
        settings: {
          id,
          value: settings,
          appearance: theme.appearance,
          clientTheme: theme.id,
          onChange: (change) => cardsRef.current.setSettings(id, change)
        },
        ...(floating
          ? {
              translucency: {
                solidity: floating.solidity,
                onChange: (solidity: number) => cardsRef.current.setSolidity(id, solidity)
              },
              pinned: floating.pinned === true,
              onPin: (next: boolean) => cardsRef.current.pin(id, next)
            }
          : {}),
        /*
         * The corner grip, on the rail only: a float has its own, and a
         * docked strip is sized by its splitter. The height rides along where
         * one has been dragged, and its absence means the card's own.
         */
        ...(lane === 'rail'
          ? {
              ...(height !== undefined ? { height } : {}),
              onResize: (event: React.PointerEvent<HTMLElement>) =>
                resizeRef.current.begin(id, event),
              onResizeReset: () => cardsRef.current.resetHeight(id)
            }
          : {})
      };
      chromeCache.current.set(id, { key, focus: returnFocus, settings, chrome });
      return chrome;
    },
    // The theme is a real dependency and not only part of the key: the palette
    // picker offers the half of the registry that matches what the client is
    // wearing, so a card whose chrome was built under the old one would go on
    // offering dark palettes to a light client.
    [returnFocus, theme]
  );

  const renderCard = useCallback(
    (id: CardId): ReactNode => {
      // Diagnostics are still a group, toggled together by the rail shortcut.
      // A card the player has *floated* is exempt: lifting it off the rail is
      // an explicit request to keep it in view.
      const floating = cards.floatOf(id);
      const diagnostic =
        id === 'session' || id === 'link' || id === 'automation' || id === 'stream';
      if (diagnostic && !railOpen && !floating) return null;
      if (!diagnostic && !hudOpen && !floating) return null;
      // Nothing to read until the character is actually in the realm; the
      // standby card says so once, for the whole rail, rather than per card.
      if (!diagnostic && !inGame) return null;

      return cardElement(id, contextFor(session, view, chromeFor(id)));
    },
    /*
     * `view`'s consumed fields are enumerated rather than the object listed,
     * so a push that only touches bookkeeping does not rebuild every card.
     */
    [
      automation,
      cards,
      character,
      chromeFor,
      contextFor,
      drag,
      hudOpen,
      inGame,
      lines,
      railOpen,
      session,
      state,
      telnetEvents,
      view.learned,
      // The Navigation card reads loop progress through `view`, so it is a
      // real dependency — omitted, the card kept a stale closure whenever a
      // loop push landed in a render where nothing else here moved. Same
      // defect the `commands` memo had with `view.loop.status`.
      view.loop,
      view.notices,
      view.talk,
      walk
    ]
  );

  /**
   * A pinned float belonging to a character that is *not* shown.
   *
   * Every callback is bound to that character, never to the shown one: a
   * Talk card pinned from the healer sends as the healer. What it cannot do
   * is be dragged by its header — the drag machine belongs to the shown
   * character's rail — so it moves once that character is shown.
   */
  const renderPinned = useCallback(
    (id: CardId, sid: SessionId, layout: CardLayoutApi): ReactNode => {
      const floating = layout.floatOf(id);
      if (!floating) return null;
      const v = views[sid] ?? EMPTY_VIEW;
      const diagnostic =
        id === 'session' || id === 'link' || id === 'automation' || id === 'stream';
      const live = v.character.phase === 'in-game';
      if (!diagnostic && !live) return null;
      const chrome: CardChrome = {
        cardId: id,
        onClose: () => layout.hide(id),
        returnFocus,
        // That character's own settings, read and written through that
        // character's own layout — a pinned float belongs to somebody else,
        // and the rest of this object is addressed the same way.
        settings: {
          id,
          value: layout.settingsOf(id),
          appearance: theme.appearance,
          clientTheme: theme.id,
          onChange: (change) => layout.setSettings(id, change)
        },
        translucency: {
          solidity: floating.solidity,
          onChange: (solidity: number) => layout.setSolidity(id, solidity)
        },
        pinned: true,
        onPin: (next: boolean) => layout.pin(id, next)
      };
      return cardElement(id, contextFor(sid, v, chrome));
    },
    [contextFor, returnFocus, theme, views]
  );

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

        {showTabs && tabSide === 'left' && (
          <Splitter
            edge="left"
            label={t('splitter.aria.tabRailWidth')}
            measure={measureTabs}
            onChange={widths.setTabs}
            onDragging={setResizing}
            onReset={resetTabs}
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
                  onInspect={inspectAt}
                  onChooseRoom={chooseRoomNamed}
                  onResize={handleResize}
                  onSelectPlayer={selectPlayer}
                  onSelectGang={selectGang}
                  onSearchResult={setSearchResult}
                  onSnapshot={applySnapshot}
                  // A character with no pane parks in the focused one, hidden:
                  // laid out, so it stays measurable, and out of the tab order.
                  pane={at >= 0 ? at : paneAt}
                  palette={theme.terminal}
                  session={entry.id}
                  settings={config.terminal}
                  shown={at >= 0}
                />
              );
            })}
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
            edge="right"
            label={t('splitter.aria.cardRailWidth')}
            measure={measureRail}
            onChange={widths.setRail}
            onDragging={setResizing}
            onReset={widths.reset}
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
                onAdd={cards.show}
                // A chip is a handle as well as a button: dragged onto the
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
              render={renderPinned}
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

      {/*
        What the realm knows about a clicked name, beside the name. One at a
        time; the next click replaces it, Escape or a click elsewhere closes it.
      */}
      {asked !== null && (
        <ReferencePopover
          asked={asked}
          level={character.progress.level}
          lookup={lookupName}
          onDismiss={dismissAsked}
          /*
            A shop in `Sold by` opens the route panel, and this panel goes with
            it: one thing open at a time is the rule both slide-outs already
            keep, and two panels hanging off one click is two things to put
            away with no way to say which Escape means.
          */
          onName={inspect}
          onRoom={(map, room) => {
            dismissAsked();
            chooseOnMap(map, room);
          }}
          realm={character.realm}
          supplies={suppliesBundle(session)}
        />
      )}

      {/*
        One other person, beside the listing they were clicked on. Drawn from the
        clicked character's own registry and permissions, which is why it takes a
        session rather than reading the shown character's.
      */}
      {flyout !== null && (
        <PlayerFlyout
          asked={flyout}
          character={(views[flyout.session] ?? EMPTY_VIEW).character}
          inspect={inspect}
          onDismiss={dismissFlyout}
          onGrant={(name, grant) => void api.setRemoteGrant(flyout.session, name, grant)}
          onSelectGang={(gang, anchor) => selectGang(flyout.session, gang, anchor)}
          remotes={remotesFor(flyout.session)}
          returnFocus={returnFocus}
        />
      )}

      {/*
        One gang, beside wherever its name was clicked, and read out of the same
        character's roster and registry. Every member's name is itself a control
        that opens the panel above on them: an entity carries through.
      */}
      {gangFlyout !== null && (
        <GangFlyout
          asked={gangFlyout}
          character={(views[gangFlyout.session] ?? EMPTY_VIEW).character}
          onDismiss={dismissGangFlyout}
          onSelectPlayer={selectPlayer}
          returnFocus={returnFocus}
        />
      )}

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
        size={size}
        state={state}
      />

      <CommandPalette
        commands={commands}
        find={findRooms}
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
        onClose={closeRoute}
        onLoadMap={loadMap}
        onRoute={routeTo}
        onSearch={searchRooms}
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
        loading={catalogue === null}
        loops={loopChoices}
        onChoose={runChosenLoop}
        onClose={closeLoops}
        open={loopsOpen}
        realmName={profiles.find((profile) => profile.id === session)?.serverName ?? ''}
      />

      {/*
        The way in for somebody who has not read the source. Everything it does
        not cover — automation rules, per-character UI — stays in the YAML,
        which is what YAML is good at, and the screen says where the files are.
      */}
      <SettingsScreen
        deleteProfile={settingsApi.deleteProfile}
        deleteServer={settingsApi.deleteServer}
        load={settingsApi.load}
        maximaFor={maximaFor}
        onClose={closeSettings}
        open={settingsOpen}
        openAt={settingsAt}
        revealConfig={settingsApi.revealConfig}
        chooseRealm={settingsApi.chooseRealm}
        loadLoops={settingsApi.loadLoops}
        revealProfiles={settingsApi.revealProfiles}
        saveProfile={settingsApi.saveProfile}
        saveGlobal={settingsApi.saveGlobal}
        saveServer={settingsApi.saveServer}
      />
    </div>
  );
}
