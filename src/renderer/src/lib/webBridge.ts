/**
 * `IpcApi` over a WebSocket: the bridge for a window served over HTTP.
 *
 * The preload is the desktop's bridge and this is the browser tab's, and the
 * two are the same object literal over two carriers — every `Invoke.*`,
 * `Send.*` and `Push.*` in `src/shared/ipc.ts` appears here exactly as it
 * appears there, which is what lets `ipc-wiring.test.ts` hold both to the
 * one list. The envelope is `src/shared/rpc.ts`; the server side is
 * `src/main/host/WebHost.ts`.
 *
 * Four things the desktop asks main for are answered in the window here,
 * because main in web mode is on another machine:
 *
 * - **the clipboard** — `navigator.clipboard`, which a browser tab may use
 *   on a user gesture and which the desktop avoids for reasons that do not
 *   apply here (`Invoke.copyText`'s note);
 * - **the realm picker** — the window's own, over `Invoke.browseHome`
 *   (`lib/pickers.ts`), because the disk is the client's and not the
 *   viewer's;
 * - **a saved file** — the debug report and a character export are written
 *   on the client's disk as on the desktop, then fetched into the browser's
 *   downloads over the link main hands back (`Host.deliver`);
 * - a lost socket: `lib/webLink.ts` dials again and the client sends what
 *   was missed, so the window carries on as it was. Only a client that no
 *   longer knows the tab makes `onRenewed` remount the window, which
 *   re-attaches every character and replays the backscroll main kept.
 *
 * A call made while the link is down waits for it and goes when it is back,
 * except a key: one typed once the window is covered goes nowhere, and one
 * older than `webLostCoverMs` when the link comes back is not sent, since
 * keys typed into a dead link would arrive as a burst of moves.
 */
import {
  Invoke,
  Push,
  Send,
  type SavedFile,
  type DebugSave,
  type IpcApi,
  type Notice
} from '@shared/ipc';
import { trimArgs, type RpcOutbound } from '@shared/rpc';
import { t } from './i18n';
import { hasHomePicker, pickFromHome } from './pickers';
import { openWebLink } from './webLink';

type Listener = (payload: unknown) => void;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * @param onRenewed The client no longer knows this tab; the window remounts.
 * @param signal Ends the bridge: its timers, its listeners and its socket.
 */
export function createWebBridge(onRenewed: () => void, signal: AbortSignal): IpcApi {
  const listeners = new Map<string, Set<Listener>>();
  const pending = new Map<number, Pending>();
  let nextId = 1;

  /** A notice into the console, from the window itself. Same shape as main's. */
  const notice = (message: string): void => {
    const payload: Notice = { session: null, message };
    for (const listener of listeners.get(Push.notice) ?? []) listener(payload);
  };

  /*
   * The window's own picker over the client's disk (`lib/pickers.ts`), never
   * a channel: main in web mode has no dialog to put up, and a
   * `<input type="file">` would browse the wrong machine.
   */
  const pickOnTheClient = (): Promise<string | null> => {
    if (!hasHomePicker()) {
      notice(t('web.picker.unavailable'));
      return Promise.resolve(null);
    }
    return pickFromHome();
  };

  /** A file main wrote and offered, saved into the browser's downloads. */
  const download = (link: string | null): void => {
    if (link === null) return;
    const anchor = document.createElement('a');
    anchor.href = link;
    anchor.download = '';
    anchor.click();
  };
  /** A channel main answers with a `SavedFile`, the written one downloaded into the tab. */
  const delivered = async (channel: string, ...args: unknown[]): Promise<SavedFile> => {
    const result = await invoke<SavedFile>(channel, ...args);
    if (result.kind === 'written') download(result.download);
    return result;
  };

  const take = (message: RpcOutbound): void => {
    if (message.k === 'push') {
      for (const listener of listeners.get(message.c) ?? []) listener(message.p);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if ('e' in message) entry.reject(new Error(message.e));
    else entry.resolve(message.r);
  };

  const link = openWebLink(
    {
      frame: take,
      /*
       * Every call still waiting is left waiting, deliberately: rejecting
       * them surfaced each as an uncaught rejection, since on the desktop the
       * bridge cannot fail and none of the callers catches. The remount drops
       * the callers, and a promise that never settles under them costs nothing.
       */
      renewed: () => {
        pending.clear();
        onRenewed();
      }
    },
    signal
  );

  const send = (channel: string, ...args: unknown[]): void => {
    link.send({ k: 'send', c: channel, a: trimArgs(args) });
  };

  /** A key typed into a covered window goes nowhere (the header's reason). */
  const type = (channel: string, ...args: unknown[]): void => {
    if (!link.covered) link.send({ k: 'send', c: channel, a: trimArgs(args) }, true);
  };

  const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      link.send({ k: 'invoke', id, c: channel, a: trimArgs(args) });
    });

  const subscribe = <T>(channel: string, handler: (payload: T) => void): (() => void) => {
    const listener: Listener = (payload) => handler(payload as T);
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };

  return {
    host: 'web',

    clientReady: () => send(Send.clientReady),
    input: (session, data) => type(Send.input, session, data),
    macro: (session, line) => type(Send.macro, session, line),
    dropMacro: (session) => send(Send.dropMacro, session),
    resize: (session, size) => send(Send.resize, session, size),
    lostEnter: (session, report) => send(Send.lostEnter, session, report),
    diagnostics: (on) => send(Send.diagnostics, on),
    debugFeed: (on) => send(Send.debugFeed, on),

    connect: (session, target) => invoke(Invoke.connect, session, target),
    disconnect: (session) => invoke(Invoke.disconnect, session),
    getState: (session) => invoke(Invoke.getState, session),
    getTelnetLog: (session) => invoke(Invoke.getTelnetLog, session),
    getLines: (session) => invoke(Invoke.getLines, session),
    getDebug: (session) => invoke(Invoke.getDebug, session),
    getUnread: (session) => invoke(Invoke.getUnread, session),
    saveDebug: async (session) => {
      const saved = await invoke<DebugSave>(Invoke.saveDebug, session);
      if ('path' in saved) download(saved.download);
      return saved;
    },
    getCharacter: (session) => invoke(Invoke.getCharacter, session),
    routeTo: (session, map, room) => invoke(Invoke.routeTo, session, map, room),
    routeBetween: (session, from, to) => invoke(Invoke.routeBetween, session, from, to),
    walkPages: (session) => invoke(Invoke.walkPages, session),
    walkRoute: (session, route, run) => invoke(Invoke.walkRoute, session, route, run),
    startMoving: (session, loop, confirmed) => invoke(Invoke.startMoving, session, loop, confirmed),
    collectThenWalk: (session, items, route, run) =>
      invoke(Invoke.collectThenWalk, session, items, route, run),
    previewAreaSearch: (session, radius) => invoke(Invoke.previewAreaSearch, session, radius),
    searchArea: (session, radius, searches) => invoke(Invoke.searchArea, session, radius, searches),
    previewMobFind: (session, name) => invoke(Invoke.previewMobFind, session, name),
    findMob: (session, name) => invoke(Invoke.findMob, session, name),
    cashRunTokens: (session) => invoke(Invoke.cashRunTokens, session),
    startCashRun: (session, ask) => invoke(Invoke.startCashRun, session, ask),
    stopMoving: (session) => invoke(Invoke.stopMoving, session),
    inheritedMobRules: (scope, realm) => invoke(Invoke.inheritedMobRules, scope, realm),
    portrait: (session) => invoke(Invoke.portrait, session),
    savePortrait: (session) => delivered(Invoke.savePortrait, session),
    roomArt: (session) => invoke(Invoke.roomArt, session),
    treatMonster: (session, mob, treat) => invoke(Invoke.treatMonster, session, mob, treat),
    walkOnWithoutParty: (session) => invoke(Invoke.walkOnWithoutParty, session),
    stepBack: (session, confirmed) => invoke(Invoke.stepBack, session, confirmed),
    listLoops: (session) => invoke(Invoke.listLoops, session),
    startLoop: (session, name) => invoke(Invoke.startLoop, session, name),
    recentLoops: (session) => invoke(Invoke.recentLoops, session),
    reverseLoop: (session) => invoke(Invoke.reverseLoop, session),
    loopCatalogue: () => invoke(Invoke.loopCatalogue),
    saveGlobal: (draft) => invoke(Invoke.saveGlobal, draft),
    setRemoteGrant: (session, name, grant) => invoke(Invoke.setRemoteGrant, session, name, grant),
    setGangRemotes: (session, remotes) => invoke(Invoke.setGangRemotes, session, remotes),
    setRemoteGangpath: (session, on) => invoke(Invoke.setRemoteGangpath, session, on),
    setAutomationSwitch: (session, name, on) =>
      invoke(Invoke.setAutomationSwitch, session, name, on),
    setThreshold: (session, which, value) => invoke(Invoke.setThreshold, session, which, value),
    setSupplies: (session, items) => invoke(Invoke.setSupplies, session, items),
    addLoop: (scope, owner, loop) => invoke(Invoke.addLoop, scope, owner, loop),
    runLoop: (session, loop) => invoke(Invoke.runLoop, session, loop),
    loopJoin: (session, loop) => invoke(Invoke.loopJoin, session, loop),
    loopThrough: (session) => invoke(Invoke.loopThrough, session),
    getWalk: (session) => invoke(Invoke.getWalk, session),
    getAutomation: (session) => invoke(Invoke.getAutomation, session),
    listExtensions: () => invoke(Invoke.listExtensions),
    extensionAction: (session, name, action, args) =>
      invoke(Invoke.extensionAction, session, name, action, args),

    listSessions: () => invoke(Invoke.listSessions),
    listProfiles: () => invoke(Invoke.listProfiles),
    loadProfile: (id) => invoke(Invoke.loadProfile, id),
    unloadProfile: (id, force) => invoke(Invoke.unloadProfile, id, force),
    attach: (session) => invoke(Invoke.attach, session),
    detach: (session) => invoke(Invoke.detach, session),
    backscrollPage: (session, lines) => invoke(Invoke.backscrollPage, session, lines),
    popOut: (session) => invoke(Invoke.popOut, session),
    reorderSessions: (order) => invoke(Invoke.reorderSessions, order),
    popIn: (session) => invoke(Invoke.popIn, session),
    gatherWindows: () => invoke(Invoke.gatherWindows),
    // The tab is on the viewer's machine and main is not, so raising *this*
    // window means this window. The browser grants it off a notification click.
    raiseWindow: async () => {
      window.focus();
    },

    getConfig: () => invoke(Invoke.getConfig),
    getInternal: () => invoke(Invoke.getInternal),
    revealConfig: () => invoke(Invoke.revealConfig),
    revealProfiles: () => invoke(Invoke.revealProfiles),
    revealLogs: () => invoke(Invoke.revealLogs),
    browseHome: (target) => invoke(Invoke.browseHome, target),

    /*
     * The window's clipboard, not main's — see the header. Writing works on
     * the gesture that asked for it; reading is the tab's permission to
     * grant, and a browser that will not grant it is answered with nothing
     * and a notice saying the chord the browser handles itself still works.
     */
    copyText: async (text) => {
      if (text.length === 0) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        notice(t('web.clipboard.writeRefused'));
      }
    },
    copyImage: async (png) => {
      try {
        // Decoded here: the page's policy keeps `fetch` off `data:` URLs.
        const bytes = Uint8Array.from(atob(png.slice(png.indexOf(',') + 1)), (c) =>
          c.charCodeAt(0)
        );
        const blob = new Blob([bytes], { type: 'image/png' });
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return true;
      } catch (error) {
        console.warn(`clipboard: the picture was not written: ${String(error)}`);
        notice(t('web.clipboard.imageRefused'));
        return false;
      }
    },
    pasteText: async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        notice(t('web.clipboard.readRefused'));
        return '';
      }
    },

    saveProfile: (id, draft) => invoke(Invoke.saveProfile, id, draft),
    deleteProfile: (id) => invoke(Invoke.deleteProfile, id),
    saveServer: (previousName, draft) => invoke(Invoke.saveServer, previousName, draft),
    deleteServer: (name) => invoke(Invoke.deleteServer, name),
    settingsSnapshot: () => invoke(Invoke.settingsSnapshot),
    chooseRealm: () => pickOnTheClient(),
    exportCharacter: (id, password) => delivered(Invoke.exportCharacter, id, password),
    chooseCharacterFile: () => pickOnTheClient(),
    importCharacter: (file) => invoke(Invoke.importCharacter, file),
    searchRooms: (session, query) => invoke(Invoke.searchRooms, session, query),
    mobNames: (session) => invoke(Invoke.mobNames, session),
    worldInfo: (session) => invoke(Invoke.worldInfo, session),
    realmWorld: (host, port) => invoke(Invoke.realmWorld, host, port),
    questBook: (session) => invoke(Invoke.questBook, session),
    questErrand: (session, block) => invoke(Invoke.questErrand, session, block),
    questPlan: (session, block, marked) => invoke(Invoke.questPlan, session, block, marked),
    questRun: (session, block, marked) => invoke(Invoke.questRun, session, block, marked),
    questReach: (session, marks) => invoke(Invoke.questReach, session, marks),
    gearChoices: (session) => invoke(Invoke.gearChoices, session),
    gearBlessItems: (session) => invoke(Invoke.gearBlessItems, session),
    gearPlan: (session, picks) => invoke(Invoke.gearPlan, session, picks),
    gearTrip: (session, picks, run) => invoke(Invoke.gearTrip, session, picks, run),
    gearStop: (session) => invoke(Invoke.gearStop, session),
    questStop: (session) => invoke(Invoke.questStop, session),
    localMap: (session, map, room, area) => invoke(Invoke.localMap, session, map, room, area),
    gameMap: (session, ask) => invoke(Invoke.gameMap, session, ask),
    roomBrief: (session, map, room) => invoke(Invoke.roomBrief, session, map, room),
    slotGear: (session, slot) => invoke(Invoke.slotGear, session, slot),
    chosenWords: (session) => invoke(Invoke.chosenWords, session),
    blessingChoice: (session) => invoke(Invoke.blessingChoice, session),
    huntingGrounds: (session, measure) => invoke(Invoke.huntingGrounds, session, measure),
    trainers: (session) => invoke(Invoke.trainers, session),
    banks: (session) => invoke(Invoke.banks, session),
    supplyCounters: (session) => invoke(Invoke.supplyCounters, session),
    nearestPlaces: (session, kind) => invoke(Invoke.nearestPlaces, session, kind),
    itemsServing: (session) => invoke(Invoke.itemsServing, session),
    wards: (session) => invoke(Invoke.wards, session),
    invokeChoices: (session) => invoke(Invoke.invokeChoices, session),
    draftLoop: (session, rooms) => invoke(Invoke.draftLoop, session, rooms),
    wearer: (session) => invoke(Invoke.wearer, session),
    lookup: (session, query) => invoke(Invoke.lookup, session, query),
    forget: (session, discovery) => invoke(Invoke.forget, session, discovery),
    forgetFind: (session, find) => invoke(Invoke.forgetFind, session, find),
    forgetCharacter: (session) => invoke(Invoke.forgetCharacter, session),
    answerLowLives: (session, answer) => invoke(Invoke.answerLowLives, session, answer),
    resetStats: (session) => invoke(Invoke.resetStats, session),
    names: (session) => invoke(Invoke.names, session),
    ask: (session, command) => invoke(Invoke.ask, session, command),
    locate: (session) => invoke(Invoke.locate, session),
    gear: (session, action, item) => invoke(Invoke.gear, session, action, item),
    terminalAct: (session, action) => invoke(Invoke.terminalAct, session, action),
    askRemote: (session, who, name) => invoke(Invoke.askRemote, session, who, name),

    onData: (handler) => subscribe(Push.data, handler),
    onMarks: (handler) => subscribe(Push.marks, handler),
    onState: (handler) => subscribe(Push.state, handler),
    onTelnet: (handler) => subscribe(Push.telnet, handler),
    onLine: (handler) => subscribe(Push.line, handler),
    onDebug: (handler) => subscribe(Push.debug, handler),
    onBlock: (handler) => subscribe(Push.block, handler),
    onCharacter: (handler) => subscribe(Push.character, handler),
    onPlayers: (handler) => subscribe(Push.players, handler),
    onPortrait: (handler) => subscribe(Push.portrait, handler),
    onRoomArt: (handler) => subscribe(Push.roomArt, handler),
    onWalk: (handler) => subscribe(Push.walk, handler),
    onLoop: (handler) => subscribe(Push.loop, handler),
    onAutomation: (handler) => subscribe(Push.automation, handler),
    onVerdict: (handler) => subscribe(Push.verdict, handler),
    onAsks: (handler) => subscribe(Push.asks, handler),
    onStatsBase: (handler) => subscribe(Push.statsBase, handler),
    onNotice: (handler) => subscribe(Push.notice, handler),
    onSessions: (handler) => subscribe(Push.sessions, handler),
    onProfiles: (handler) => subscribe(Push.profiles, handler),
    onLearned: (handler) => subscribe(Push.learned, handler),
    onFinds: (handler) => subscribe(Push.finds, handler),
    onShops: (handler) => subscribe(Push.shops, handler),
    onCharacterReset: (handler) => subscribe(Push.characterReset, handler),
    onLowLives: (handler) => subscribe(Push.lowLives, handler),
    onQuestSaid: (handler) => subscribe(Push.questSaid, handler),
    onQuestRun: (handler) => subscribe(Push.questRun, handler),
    onGearTrip: (handler) => subscribe(Push.gearTrip, handler),
    onConfig: (handler) => subscribe(Push.config, handler),
    onInternal: (handler) => subscribe(Push.internal, handler)
  };
}
