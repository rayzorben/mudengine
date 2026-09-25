/**
 * Everything a card reads, addressed to one character: the shown one, or one
 * whose float is pinned in view. The shown character keeps its own
 * callbacks; any other gets a bundle bound to it, built once and kept, since
 * every card is memoised and a closure per render defeats that.
 *
 * Out of `App` (todo 733); `cardElement` draws from it. See `mudengine-ui` ›
 * *The window redraws what changed*.
 */
import { useCallback, useEffect, useRef } from 'react';

import type { CardChrome } from '../components/BentoCard';
import type { PlayerAsked } from '../components/PlayerFlyout';
import type { SupplyList } from '../components/SupplyControls';
import type { BuilderApi } from './useLoopBuilder';
import type { SessionView } from './useSessionViews';
import { ZERO_METER, type Pressure, type StreamMeter } from './useStreamPressure';
import type { PinnedToolbar } from './useToolbarPins';
import type { LoopDestination } from '../lib/loops';
import type { NameIndex } from '../lib/names';
import type { PopoverAnchor } from '../lib/popover';
import type { ToolbarSubject } from '../lib/toolbar';
import type { CharacterState } from '@shared/character';
import type { AppConfig, AutomationSwitches, RemotesConfig, SupplyItem } from '@shared/config';
import { canRestore, type GearAction } from '@shared/gear';
import type { Find } from '@shared/finds';
import type { HuntingRoom } from '@shared/hunting';
import type { IpcApi, SessionId, SessionSummary } from '@shared/ipc';
import type { Loop } from '@shared/loops';
import type { Discovery } from '@shared/memory';
import { movementOf } from '@shared/movement';
import { playerKey } from '@shared/players';
import type { RemoteName } from '@shared/remotes';
import type { TerminalSize } from '@shared/types';
import type { RoomId } from '@shared/world';

/**
 * Everything a card reads, gathered so one function draws a card for *any*
 * character — the shown one, or one whose float is pinned in view.
 */
export interface CardContext {
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
  /** Asks the realm where this character stands, in the word main chooses (todo 811). */
  locate(): void;
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
  /** Strikes a find out of the realm's log. See `RoomCard`'s Finds face. */
  forgetFind(find: Pick<Find, 'room' | 'name'>): void;
  inspect(name: string, anchor: HTMLElement): void;
  loadWearer(): ReturnType<IpcApi['wearer']>;
  loadMap(map: number, room: number, radius?: number): ReturnType<IpcApi['localMap']>;
  lookupName(query: string): ReturnType<IpcApi['lookup']>;
  /** Null for a character not shown: the route panel is the shown one's. */
  chooseOnMap: ((map: number, room: number) => void) | null;
  /**
   * A room pointed at on the map, and the pointer leaving it. Null for a
   * character not shown, for `chooseOnMap`'s reason: the panel asks that
   * character's realm and a float belongs to somebody else.
   */
  peekRoom: ((room: RoomId, at: SVGGElement, settled: boolean) => void) | null;
  endPeek: (() => void) | null;
  /** The same panel from a `map/room` string, which is how the realm writes it. */
  goToRoom(room: string): void;
  /**
   * The realm's quest book, **addressed** and asked for by the card itself.
   *
   * Data rather than a call was the first shape, and it was the one thing in
   * this object that was not addressed: a pinned float belonging to a
   * character on another `world.database` listed the *shown* character's
   * quests, and the card then wrote that realm's quest ids into this
   * character's hidden-and-ranked store. Every other world query here is a
   * bound call for exactly that reason.
   */
  loadQuests(): ReturnType<IpcApi['questBook']>;
  /**
   * The order the step this character is on fetches its items in — addressed
   * for the book's own reason, and because the walk starts where *this*
   * character is standing and is priced against what it can get through.
   */
  loadErrand(block: number): ReturnType<IpcApi['questErrand']>;
  /** The plan to reach one step, from where this character stands — addressed, like the errand. */
  loadPlan(block: number, marked: number | null): ReturnType<IpcApi['questPlan']>;
  /** Run that plan (todo 102), and stop it. Addressed like the plan. */
  runPlan(block: number, marked: number | null): ReturnType<IpcApi['questRun']>;
  stopRun(): void;
  /** Where to hunt from where this character stands — addressed, like the book. */
  loadHunting(measure: string | null): ReturnType<IpcApi['huntingGrounds']>;
  /**
   * Walks a loop the Hunting card built, filed nowhere or under this
   * character — the builder's own save, offered for the *shown* character
   * only, since a lap started on a pinned float's character is a character
   * walked away while somebody watches another.
   */
  runHunt: ((loop: Loop, destination: LoopDestination) => void) | null;
  /** Opens the builder on a loop the Hunting card drew, named; the shown character's only. */
  createHunt: ((rooms: HuntingRoom[], name: string) => void) | null;
  /**
   * When the configuration last reloaded, so the book is asked for again.
   *
   * A character can be pointed at a different realm by an edit to the options
   * file, and `loadedAt` is what moves when it is. The same number for every
   * session, because the file is one file.
   */
  realmAt: number;
  /**
   * The loop builder's calls, addressed at the shown character — it plans
   * on that realm and files into that scope — and null on a pinned float,
   * where the card is not drawn at all rather than drawn for the wrong one.
   */
  builder: BuilderApi | null;
  /** Bring the builder out, from the Map card's own action. Null with `builder`. */
  openBuilder: (() => void) | null;
  /** Re-base the Combat Stats card to this character's totals as they stand. */
  resetStats(): void;
  /**
   * The Navigation card's transport. `startMoving` takes the picker's choice,
   * or null where there is none; `loops` is the character's own list to pick
   * from — null on a pinned float, whose list belongs to the shown character.
   */
  loops: ReadonlyArray<{ name: string; stops: number }> | null;
  startMoving(loop: string | null): void;
  stopMoving(): void;
  startLoop(name: string): void;
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
  /** A talk-box line of several commands, and dropping what is left of one; addressed. */
  onMacro(line: string): void;
  dropMacro(): void;
}

/**
 * The addressed callbacks a card receives — the always-addressed ones (`gear`,
 * `selectPlayer`, the gang writes) and every one a pinned float gets in place
 * of the shown character's. Built once per character and cached (`boundFor`),
 * because every card is memoised and a fresh closure per render defeats that
 * wholesale — which was most of what a state flush cost.
 */
export interface AddressedActions {
  ask(command: string): void;
  locate(): void;
  forget(discovery: Discovery): void;
  forgetFind(find: Pick<Find, 'room' | 'name'>): void;
  gear(action: GearAction, item?: string): void;
  loadWearer(): ReturnType<IpcApi['wearer']>;
  loadMap(map: number, room: number, radius?: number): ReturnType<IpcApi['localMap']>;
  lookupName(query: string): ReturnType<IpcApi['lookup']>;
  loadQuests(): ReturnType<IpcApi['questBook']>;
  loadErrand(block: number): ReturnType<IpcApi['questErrand']>;
  loadPlan(block: number, marked: number | null): ReturnType<IpcApi['questPlan']>;
  runPlan(block: number, marked: number | null): ReturnType<IpcApi['questRun']>;
  stopRun(): void;
  loadHunting(measure: string | null): ReturnType<IpcApi['huntingGrounds']>;
  startMoving(loop: string | null): void;
  stopMoving(): void;
  /** Re-base the Combat Stats card to this character's totals as they stand. */
  resetStats(): void;
  startLoop(name: string): void;
  skipLoop(): void;
  reverseLoop(): void;
  selectPlayer(name: string, anchor: PopoverAnchor): void;
  setGangRemotes(remotes: RemoteName[]): void;
  setGangpath(on: boolean): void;
  setSupplies(items: SupplyItem[]): void;
  send(line: string): void;
  macro(line: string): void;
  dropMacro(): void;
}

/** The bridge calls a card makes, each addressed at one character. */
export type CardApi = Pick<
  IpcApi,
  | 'ask'
  | 'locate'
  | 'forget'
  | 'forgetFind'
  | 'gear'
  | 'wearer'
  | 'localMap'
  | 'lookup'
  | 'questBook'
  | 'questErrand'
  | 'questPlan'
  | 'questRun'
  | 'questStop'
  | 'huntingGrounds'
  | 'stopMoving'
  | 'startLoop'
  | 'skipLoopStop'
  | 'reverseLoop'
  | 'setGangRemotes'
  | 'setRemoteGangpath'
  | 'setSupplies'
  | 'input'
  | 'macro'
  | 'dropMacro'
  | 'setAutomationSwitch'
>;

/** The shown character's own controls, which a pinned float never borrows. */
type Shown<K extends keyof CardContext> = { [P in K]-?: NonNullable<CardContext[P]> };

/** What the contexts are built from, all of it `App`'s. */
export interface CardContextInputs
  extends
    Pick<
      CardContext,
      | 'thresholds'
      | 'navigationVisible'
      | 'size'
      | 'meter'
      | 'realmAt'
      | 'ask'
      | 'forget'
      | 'inspect'
      | 'loadWearer'
      | 'loadMap'
      | 'lookupName'
      | 'goToRoom'
      | 'startMoving'
      | 'stopMoving'
      | 'startLoop'
      | 'skipLoop'
      | 'reverseLoop'
    >,
    Shown<
      | 'chooseOnMap'
      | 'peekRoom'
      | 'endPeek'
      | 'runHunt'
      | 'createHunt'
      | 'builder'
      | 'openBuilder'
      | 'loops'
    > {
  api: CardApi;
  /** The character on screen. */
  session: SessionId;
  /** The roster: a closed character's bundle goes with it. */
  sessions: readonly Pick<SessionSummary, 'id'>[];
  pressure: Pressure;
  /** The open Player flyout, whose subject a listing marks. */
  flyout: Pick<PlayerAsked, 'session' | 'name'> | null;
  nameIndexes: Readonly<Record<SessionId, NameIndex>>;
  toolbarPins: PinnedToolbar;
  remotesFor(id: SessionId): RemotesConfig;
  switchesFor(id: SessionId): AutomationSwitches;
  suppliesFor(id: SessionId): SupplyItem[];
  profileNameFor(id: SessionId): string;
  /** A Talk-card line from the shown character. */
  send(line: string): void;
  /** The Loops modal, which is the shown character's. */
  openLoops(): void;
  dial(id: SessionId): void;
  hangUp(id: SessionId): void;
  /** A refusal said in its own character's console. */
  sayRefusal(sid: SessionId): (refused: string | null) => void;
  startMovingIn(sid: SessionId, loop: string | null, confirmed: number | null): void;
  stepBackIn(sid: SessionId, confirmed: number | null): void;
  selectPlayer(sid: SessionId, name: string, anchor: PopoverAnchor): void;
  resetStats(sid: SessionId): void;
}

export interface CardContexts {
  contextFor(sid: SessionId, v: SessionView, chrome: CardChrome): CardContext;
  /** One character's supplies list and its write, one object for as long as the list is. */
  suppliesBundle(sid: SessionId): SupplyList;
}

export function useCardContext({
  api,
  session,
  sessions,
  thresholds,
  navigationVisible,
  size,
  meter,
  pressure,
  realmAt,
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
  builder,
  openBuilder,
  startMoving,
  stopMoving,
  startLoop,
  skipLoop,
  reverseLoop,
  send,
  openLoops,
  dial,
  hangUp,
  sayRefusal,
  startMovingIn,
  stepBackIn,
  selectPlayer,
  resetStats
}: CardContextInputs): CardContexts {
  /*
   * Read through refs by the cached bundles below, so a bundle built on the
   * first render cannot hold a stale flyout opener or refusal reporter.
   */
  const selectPlayerRef = useRef(selectPlayer);
  selectPlayerRef.current = selectPlayer;
  const sayRefusalRef = useRef(sayRefusal);
  sayRefusalRef.current = sayRefusal;
  const startMovingRef = useRef(startMovingIn);
  startMovingRef.current = startMovingIn;

  const resetStatsRef = useRef(resetStats);
  resetStatsRef.current = resetStats;

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
        locate: () => void api.locate(sid),
        forget: (discovery) => void api.forget(sid, discovery),
        forgetFind: (find) => void api.forgetFind(sid, find),
        gear: (action, item) => void api.gear(sid, action, item),
        loadWearer: () => api.wearer(sid),
        loadMap: (map, room, radius) => api.localMap(sid, map, room, radius),
        lookupName: (query) => api.lookup(sid, query),
        loadQuests: () => api.questBook(sid),
        loadErrand: (block) => api.questErrand(sid, block),
        loadPlan: (block, marked) => api.questPlan(sid, block, marked),
        runPlan: (block, marked) => api.questRun(sid, block, marked),
        stopRun: () => void api.questStop(sid),
        loadHunting: (measure) => api.huntingGrounds(sid, measure),
        startMoving: (loop) => startMovingRef.current(sid, loop, null),
        stopMoving: () => void api.stopMoving(sid),
        // Through a ref like `selectPlayer` beside it: this one changes the
        // window's state rather than sending anything, and the bound object has to
        // stay the same object across renders or every card's memo is defeated.
        resetStats: () => resetStatsRef.current(sid),
        startLoop: (name) =>
          void api.startLoop(sid, name).then((refused) => sayRefusalRef.current(sid)(refused)),
        skipLoop: () =>
          void api.skipLoopStop(sid).then((refused) => sayRefusalRef.current(sid)(refused)),
        reverseLoop: () =>
          void api.reverseLoop(sid).then((refused) => sayRefusalRef.current(sid)(refused)),
        selectPlayer: (name, anchor) => selectPlayerRef.current(sid, name, anchor),
        setGangRemotes: (remotes) => void api.setGangRemotes(sid, remotes),
        setGangpath: (on) => void api.setRemoteGangpath(sid, on),
        setSupplies: (items) =>
          void api.setSupplies(sid, items).then((refused) => sayRefusalRef.current(sid)(refused)),
        send: (line) => void api.input(sid, `${line}\r`),
        macro: (line) => api.macro(sid, line),
        dropMacro: () => api.dropMacro(sid)
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
        thresholds,
        navigationVisible: shown
          ? navigationVisible
          : v.walk.status !== 'idle' || v.loop.status !== 'idle',
        size,
        meter: shown ? meter : ZERO_METER,
        quiet: pressure === 'high',
        ask: shown ? ask : bound.ask,
        locate: bound.locate,
        forget: shown ? forget : bound.forget,
        forgetFind: bound.forgetFind,
        inspect,
        gear: bound.gear,
        loadWearer: shown ? loadWearer : bound.loadWearer,
        loadMap: shown ? loadMap : bound.loadMap,
        lookupName: shown ? lookupName : bound.lookupName,
        chooseOnMap: shown ? chooseOnMap : null,
        peekRoom: shown ? peekRoom : null,
        endPeek: shown ? endPeek : null,
        goToRoom,
        loadQuests: bound.loadQuests,
        loadErrand: bound.loadErrand,
        loadPlan: bound.loadPlan,
        runPlan: bound.runPlan,
        stopRun: bound.stopRun,
        loadHunting: bound.loadHunting,
        runHunt: shown ? runHunt : null,
        createHunt: shown ? createHunt : null,
        realmAt,
        builder: shown ? builder : null,
        openBuilder: shown ? openBuilder : null,
        startMoving: shown ? startMoving : bound.startMoving,
        stopMoving: shown ? stopMoving : bound.stopMoving,
        // Addressed always: a pinned float's Reset re-bases that character's
        // card, never the one being watched.
        resetStats: bound.resetStats,
        // The shown character's list is the only one the renderer holds; a
        // float's own loops are not asked for, so it offers no picker.
        loops: shown ? loops : null,
        startLoop: shown ? startLoop : bound.startLoop,
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
          // The same reading the rail's `inGame` makes, because the toolbar is
          // the one card drawn on both sides of it.
          inRealm: v.character.phase === 'in-game',
          dialling: v.state.phase === 'connecting' || v.state.phase === 'closing',
          // One reading of the two progresses, shared with the Navigation
          // card, so the button and the card cannot disagree about whether
          // this character is going anywhere.
          movement: movementOf(v.walk, v.loop),
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
          // The picker is the card's; the toolbar presses play on whatever
          // this character was last walking.
          startMoving: () => startMovingIn(sid, null, null),
          stopMoving: shown ? stopMoving : () => void api.stopMoving(sid),
          stepBack: () => stepBackIn(sid, null),
          /*
           * The modal is the shown character's, like the route panel: it files
           * into a scope and starts a loop, and both are addressed at whoever
           * it was opened for. On a pinned float the button opens it for the
           * character on screen rather than for the float's own — so it is
           * `null` there and the button is not drawn, which is the rule a
           * control bound to nowhere already follows in this client.
           */
          openLoops: shown ? openLoops : null,
          openBuilder: shown ? openBuilder : null
        },
        // Per client, not per character: which buttons somebody keeps to hand
        // is a fact about the person at the keyboard, so every character's
        // toolbar draws the same row with its own answers on it.
        toolbarPinned: toolbarPins.pinned,
        pinToolbarButton: toolbarPins.toggle,
        nameIndex: nameIndexes[sid] ?? null,
        onSend: shown ? send : bound.send,
        onMacro: bound.macro,
        dropMacro: bound.dropMacro
      };
    },
    [
      api,
      ask,
      boundFor,
      builder,
      meter,
      chooseOnMap,
      goToRoom,
      openBuilder,
      profileNameFor,
      suppliesBundle,
      thresholds,
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
      send,
      selectPlayer,
      session,
      size,
      startMoving,
      startMovingIn,
      stopMoving,
      navigationVisible,
      loops,
      startLoop,
      skipLoop,
      reverseLoop,
      // Read above like the rest: now that `toolbarPins` holds still, a value
      // left off this list is a stale closure a card acts on (todo 761).
      nameIndexes,
      realmAt,
      openLoops,
      peekRoom,
      endPeek,
      runHunt,
      createHunt,
      stepBackIn
    ]
  );

  return { contextFor, suppliesBundle };
}
