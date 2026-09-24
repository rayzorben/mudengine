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
 * Three things the desktop asks main for are answered in the window here,
 * because main in web mode is on another machine:
 *
 * - **the clipboard** — `navigator.clipboard`, which a browser tab may use
 *   on a user gesture and which the desktop avoids for reasons that do not
 *   apply here (`Invoke.copyText`'s note);
 * - **the realm picker** — the window's own, over `Invoke.browseHome`
 *   (`lib/pickers.ts`), because the disk is the client's and not the
 *   viewer's;
 * - **a lost socket** — said out loud over the whole window, and the page
 *   reloads itself once the client answers again, which re-attaches every
 *   character and replays the backscroll main kept for exactly this.
 *
 * Calls made before the socket opens are queued, not dropped: `App` sends
 * `clientReady` on its first effect and the handshake is still in flight.
 */
import { Invoke, Push, Send, type IpcApi, type Notice } from '@shared/ipc';
import { asRpcOutbound, RPC_PATH, trimArgs, type RpcRequest } from '@shared/rpc';
import { t } from './i18n';
import { hasRealmPicker, pickRealm } from './pickers';
import { tuning } from './tuning';

type Listener = (payload: unknown) => void;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export function createWebBridge(): IpcApi {
  const listeners = new Map<string, Set<Listener>>();
  const pending = new Map<number, Pending>();
  const queue: RpcRequest[] = [];
  let socket: WebSocket | null = null;
  let nextId = 1;
  let lost = false;

  /** A notice into the console, from the window itself. Same shape as main's. */
  const notice = (message: string): void => {
    const payload: Notice = { session: null, message };
    for (const listener of listeners.get(Push.notice) ?? []) listener(payload);
  };

  const url = (): string => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${location.host}${RPC_PATH}`;
  };

  const transmit = (request: RpcRequest): void => {
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(request));
    } else {
      queue.push(request);
    }
  };

  /**
   * The socket is gone. The window says so over everything, then asks the
   * client every `webReconnectMs` whether it is back and reloads when it is.
   * A reload rather than a re-handshake: the attach flow was written for a
   * renderer that mounts afresh, and reusing it is the one path that cannot
   * drift from the desktop's.
   *
   * Every call waiting on the socket is left waiting, deliberately, and so
   * is every call made from now on. Rejecting them was tried first and every
   * one surfaced as an uncaught rejection: the callers are the same effects
   * and handlers the desktop runs, and on the desktop the bridge cannot fail
   * — Electron's IPC outlives the window — so none of them catches. The tab
   * is covered and about to reload; a promise that never settles under it
   * costs nothing, where seven errors nobody can act on cost the console.
   */
  const onLost = (): void => {
    if (lost) return;
    lost = true;
    pending.clear();
    showLost();
    const probe = (): void => {
      fetch('/health', { cache: 'no-store' })
        .then((response) => {
          if (response.ok) location.reload();
          else setTimeout(probe, tuning().webReconnectMs);
        })
        .catch(() => setTimeout(probe, tuning().webReconnectMs));
    };
    setTimeout(probe, tuning().webReconnectMs);
  };

  const connect = (): void => {
    const ws = new WebSocket(url());
    socket = ws;
    ws.onopen = () => {
      for (const request of queue.splice(0)) ws.send(JSON.stringify(request));
    };
    ws.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const message = asRpcOutbound(parsed);
      if (message === null) return;
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
    ws.onclose = onLost;
    ws.onerror = () => ws.close();
  };

  const send = (channel: string, ...args: unknown[]): void => {
    transmit({ k: 'send', c: channel, a: trimArgs(args) });
  };

  const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      // Left waiting, for the reason `onLost` gives: the tab is covered and
      // about to reload, and a rejection here reaches nobody who catches.
      if (lost) return;
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      transmit({ k: 'invoke', id, c: channel, a: trimArgs(args) });
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

  connect();

  return {
    host: 'web',

    clientReady: () => send(Send.clientReady),
    input: (session, data) => send(Send.input, session, data),
    macro: (session, line) => send(Send.macro, session, line),
    dropMacro: (session) => send(Send.dropMacro, session),
    resize: (session, size) => send(Send.resize, session, size),
    diagnostics: (on) => send(Send.diagnostics, on),
    debugFeed: (on) => send(Send.debugFeed, on),

    connect: (session, target) => invoke(Invoke.connect, session, target),
    disconnect: (session) => invoke(Invoke.disconnect, session),
    getState: (session) => invoke(Invoke.getState, session),
    getTelnetLog: (session) => invoke(Invoke.getTelnetLog, session),
    getLines: (session) => invoke(Invoke.getLines, session),
    getDebug: (session) => invoke(Invoke.getDebug, session),
    saveDebug: (session) => invoke(Invoke.saveDebug, session),
    getCharacter: (session) => invoke(Invoke.getCharacter, session),
    routeTo: (session, map, room) => invoke(Invoke.routeTo, session, map, room),
    walkRoute: (session, route, run) => invoke(Invoke.walkRoute, session, route, run),
    startMoving: (session, loop, confirmed) => invoke(Invoke.startMoving, session, loop, confirmed),
    collectThenWalk: (session, items, route, run) =>
      invoke(Invoke.collectThenWalk, session, items, route, run),
    stopMoving: (session) => invoke(Invoke.stopMoving, session),
    stepBack: (session, confirmed) => invoke(Invoke.stepBack, session, confirmed),
    listLoops: (session) => invoke(Invoke.listLoops, session),
    startLoop: (session, name) => invoke(Invoke.startLoop, session, name),
    skipLoopStop: (session) => invoke(Invoke.skipLoopStop, session),
    reverseLoop: (session) => invoke(Invoke.reverseLoop, session),
    loopCatalogue: () => invoke(Invoke.loopCatalogue),
    saveGlobal: (draft) => invoke(Invoke.saveGlobal, draft),
    setRemoteGrant: (session, name, grant) => invoke(Invoke.setRemoteGrant, session, name, grant),
    setGangRemotes: (session, remotes) => invoke(Invoke.setGangRemotes, session, remotes),
    setRemoteGangpath: (session, on) => invoke(Invoke.setRemoteGangpath, session, on),
    setAutomationSwitch: (session, name, on) =>
      invoke(Invoke.setAutomationSwitch, session, name, on),
    setSupplies: (session, items) => invoke(Invoke.setSupplies, session, items),
    addLoop: (scope, owner, loop) => invoke(Invoke.addLoop, scope, owner, loop),
    runLoop: (session, loop) => invoke(Invoke.runLoop, session, loop),
    getWalk: (session) => invoke(Invoke.getWalk, session),
    getAutomation: (session) => invoke(Invoke.getAutomation, session),

    listSessions: () => invoke(Invoke.listSessions),
    listProfiles: () => invoke(Invoke.listProfiles),
    loadProfile: (id) => invoke(Invoke.loadProfile, id),
    unloadProfile: (id, force) => invoke(Invoke.unloadProfile, id, force),
    attach: (session) => invoke(Invoke.attach, session),
    detach: (session) => invoke(Invoke.detach, session),
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
    /*
     * The window's own picker over the client's disk (`lib/pickers.ts`),
     * never the channel: main in web mode has no dialog to put up, and a
     * `<input type="file">` would browse the wrong machine.
     */
    chooseRealm: () => {
      if (!hasRealmPicker()) {
        notice(t('web.picker.unavailable'));
        return Promise.resolve(null);
      }
      return pickRealm();
    },
    searchRooms: (session, query) => invoke(Invoke.searchRooms, session, query),
    mobNames: (session) => invoke(Invoke.mobNames, session),
    worldInfo: (session) => invoke(Invoke.worldInfo, session),
    questBook: (session) => invoke(Invoke.questBook, session),
    questErrand: (session, block) => invoke(Invoke.questErrand, session, block),
    questPlan: (session, block, marked) => invoke(Invoke.questPlan, session, block, marked),
    questRun: (session, block, marked) => invoke(Invoke.questRun, session, block, marked),
    questStop: (session) => invoke(Invoke.questStop, session),
    localMap: (session, map, room, radius) => invoke(Invoke.localMap, session, map, room, radius),
    roomBrief: (session, map, room) => invoke(Invoke.roomBrief, session, map, room),
    huntingGrounds: (session, measure) => invoke(Invoke.huntingGrounds, session, measure),
    trainers: (session) => invoke(Invoke.trainers, session),
    banks: (session) => invoke(Invoke.banks, session),
    itemsServing: (session) => invoke(Invoke.itemsServing, session),
    wards: (session) => invoke(Invoke.wards, session),
    draftLoop: (session, rooms) => invoke(Invoke.draftLoop, session, rooms),
    wearer: (session) => invoke(Invoke.wearer, session),
    lookup: (session, query) => invoke(Invoke.lookup, session, query),
    forget: (session, discovery) => invoke(Invoke.forget, session, discovery),
    forgetFind: (session, find) => invoke(Invoke.forgetFind, session, find),
    forgetCharacter: (session) => invoke(Invoke.forgetCharacter, session),
    names: (session) => invoke(Invoke.names, session),
    ask: (session, command) => invoke(Invoke.ask, session, command),
    gear: (session, action, item) => invoke(Invoke.gear, session, action, item),
    terminalAct: (session, action) => invoke(Invoke.terminalAct, session, action),
    askRemote: (session, who, name) => invoke(Invoke.askRemote, session, who, name),

    onData: (handler) => subscribe(Push.data, handler),
    onState: (handler) => subscribe(Push.state, handler),
    onTelnet: (handler) => subscribe(Push.telnet, handler),
    onLine: (handler) => subscribe(Push.line, handler),
    onDebug: (handler) => subscribe(Push.debug, handler),
    onBlock: (handler) => subscribe(Push.block, handler),
    onCharacter: (handler) => subscribe(Push.character, handler),
    onWalk: (handler) => subscribe(Push.walk, handler),
    onLoop: (handler) => subscribe(Push.loop, handler),
    onAutomation: (handler) => subscribe(Push.automation, handler),
    onVerdict: (handler) => subscribe(Push.verdict, handler),
    onAsks: (handler) => subscribe(Push.asks, handler),
    onNotice: (handler) => subscribe(Push.notice, handler),
    onSessions: (handler) => subscribe(Push.sessions, handler),
    onProfiles: (handler) => subscribe(Push.profiles, handler),
    onLearned: (handler) => subscribe(Push.learned, handler),
    onFinds: (handler) => subscribe(Push.finds, handler),
    onCharacterReset: (handler) => subscribe(Push.characterReset, handler),
    onQuestSaid: (handler) => subscribe(Push.questSaid, handler),
    onQuestRun: (handler) => subscribe(Push.questRun, handler),
    onConfig: (handler) => subscribe(Push.config, handler),
    onInternal: (handler) => subscribe(Push.internal, handler)
  };
}

/**
 * The whole window, covered, with one sentence.
 *
 * Outside React on purpose: the bridge is what knows the socket is gone, and
 * it is constructed before React mounts. `.link-lost` is styled in
 * `index.css` from the same tokens as everything else.
 */
function showLost(): void {
  if (document.getElementById('link-lost') !== null) return;
  const cover = document.createElement('div');
  cover.id = 'link-lost';
  cover.className = 'link-lost';
  cover.setAttribute('role', 'alert');
  const panel = document.createElement('div');
  panel.className = 'link-lost-panel';
  panel.textContent = t('web.link.lost');
  cover.appendChild(panel);
  document.body.appendChild(cover);
}
