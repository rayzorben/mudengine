/**
 * The only bridge between the sandboxed renderer and the main process.
 *
 * Every method here mirrors an entry in the `IpcApi` contract, exposed as
 * `WireApi`: each push is handed over as its JSON text, and the window's
 * `lib/wire.ts` makes the `IpcApi` everything else reads. Subscription helpers
 * return an unsubscribe function so React effects can clean up without
 * leaking listeners across hot reloads.
 *
 * Anything belonging to a session takes its id as the first argument, and every
 * pushed payload arrives as `Addressed<T>`. That is the contract's doing, not a
 * convention observed here — a call that forgets which character it means does
 * not compile.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import { Invoke, Push, Send, type PushText, type SessionId, type WireApi } from '../shared/ipc';
import type { ConnectionTarget, LostEnter, TerminalSize } from '../shared/types';

/**
 * A push, handed to the window as the JSON text main sent: a string crosses
 * the context bridge as one copy, an object property by property
 * (`PUSH_METHODS`). The window parses it (`lib/wire.ts`).
 */
function subscribe(channel: string, handler: (text: PushText) => void): () => void {
  const listener = (_event: IpcRendererEvent, text: PushText): void => handler(text);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: WireApi = {
  // The preload is only ever Electron's; the web bridge says `web` of itself.
  host: 'electron',

  clientReady: () => ipcRenderer.send(Send.clientReady),
  input: (session: SessionId, data: string) => ipcRenderer.send(Send.input, session, data),
  macro: (session: SessionId, line: string) => ipcRenderer.send(Send.macro, session, line),
  dropMacro: (session: SessionId) => ipcRenderer.send(Send.dropMacro, session),
  resize: (session: SessionId, size: TerminalSize) => ipcRenderer.send(Send.resize, session, size),
  lostEnter: (session: SessionId, report: LostEnter) =>
    ipcRenderer.send(Send.lostEnter, session, report),
  diagnostics: (on: boolean) => ipcRenderer.send(Send.diagnostics, on),
  debugFeed: (on: boolean) => ipcRenderer.send(Send.debugFeed, on),

  connect: (session, target?: ConnectionTarget) =>
    ipcRenderer.invoke(Invoke.connect, session, target),
  disconnect: (session) => ipcRenderer.invoke(Invoke.disconnect, session),
  getState: (session) => ipcRenderer.invoke(Invoke.getState, session),
  getTelnetLog: (session) => ipcRenderer.invoke(Invoke.getTelnetLog, session),
  getLines: (session) => ipcRenderer.invoke(Invoke.getLines, session),
  getDebug: (session) => ipcRenderer.invoke(Invoke.getDebug, session),
  saveDebug: (session) => ipcRenderer.invoke(Invoke.saveDebug, session),
  getCharacter: (session) => ipcRenderer.invoke(Invoke.getCharacter, session),
  routeTo: (session, map, room) => ipcRenderer.invoke(Invoke.routeTo, session, map, room),
  routeBetween: (session, from, to) => ipcRenderer.invoke(Invoke.routeBetween, session, from, to),
  walkPages: (session) => ipcRenderer.invoke(Invoke.walkPages, session),
  walkRoute: (session, route, run) => ipcRenderer.invoke(Invoke.walkRoute, session, route, run),
  startMoving: (session, loop, confirmed) =>
    ipcRenderer.invoke(Invoke.startMoving, session, loop, confirmed),
  collectThenWalk: (session, items, route, run) =>
    ipcRenderer.invoke(Invoke.collectThenWalk, session, items, route, run),
  previewAreaSearch: (session, radius) =>
    ipcRenderer.invoke(Invoke.previewAreaSearch, session, radius),
  searchArea: (session, radius, searches) =>
    ipcRenderer.invoke(Invoke.searchArea, session, radius, searches),
  stopMoving: (session) => ipcRenderer.invoke(Invoke.stopMoving, session),
  stepBack: (session, confirmed) => ipcRenderer.invoke(Invoke.stepBack, session, confirmed),
  listLoops: (session) => ipcRenderer.invoke(Invoke.listLoops, session),
  startLoop: (session, name) => ipcRenderer.invoke(Invoke.startLoop, session, name),
  reverseLoop: (session) => ipcRenderer.invoke(Invoke.reverseLoop, session),
  loopCatalogue: () => ipcRenderer.invoke(Invoke.loopCatalogue),
  saveGlobal: (draft) => ipcRenderer.invoke(Invoke.saveGlobal, draft),
  setRemoteGrant: (session, name, grant) =>
    ipcRenderer.invoke(Invoke.setRemoteGrant, session, name, grant),
  setGangRemotes: (session, remotes) => ipcRenderer.invoke(Invoke.setGangRemotes, session, remotes),
  setRemoteGangpath: (session, on) => ipcRenderer.invoke(Invoke.setRemoteGangpath, session, on),
  setAutomationSwitch: (session, name, on) =>
    ipcRenderer.invoke(Invoke.setAutomationSwitch, session, name, on),
  setSupplies: (session, items) => ipcRenderer.invoke(Invoke.setSupplies, session, items),
  addLoop: (scope, owner, loop) => ipcRenderer.invoke(Invoke.addLoop, scope, owner, loop),
  runLoop: (session, loop) => ipcRenderer.invoke(Invoke.runLoop, session, loop),
  getWalk: (session) => ipcRenderer.invoke(Invoke.getWalk, session),
  getAutomation: (session) => ipcRenderer.invoke(Invoke.getAutomation, session),
  listExtensions: () => ipcRenderer.invoke(Invoke.listExtensions),
  extensionAction: (session, name, action, args) =>
    ipcRenderer.invoke(Invoke.extensionAction, session, name, action, args),

  listSessions: () => ipcRenderer.invoke(Invoke.listSessions),
  listProfiles: () => ipcRenderer.invoke(Invoke.listProfiles),
  loadProfile: (id) => ipcRenderer.invoke(Invoke.loadProfile, id),
  unloadProfile: (id, force) => ipcRenderer.invoke(Invoke.unloadProfile, id, force),
  attach: (session) => ipcRenderer.invoke(Invoke.attach, session),
  detach: (session) => ipcRenderer.invoke(Invoke.detach, session),
  backscrollPage: (session, lines) => ipcRenderer.invoke(Invoke.backscrollPage, session, lines),
  popOut: (session) => ipcRenderer.invoke(Invoke.popOut, session),
  reorderSessions: (order) => ipcRenderer.invoke(Invoke.reorderSessions, order),
  popIn: (session) => ipcRenderer.invoke(Invoke.popIn, session),
  gatherWindows: () => ipcRenderer.invoke(Invoke.gatherWindows),
  raiseWindow: () => ipcRenderer.invoke(Invoke.raiseWindow),

  getConfig: () => ipcRenderer.invoke(Invoke.getConfig),
  getInternal: () => ipcRenderer.invoke(Invoke.getInternal),
  revealConfig: () => ipcRenderer.invoke(Invoke.revealConfig),
  revealProfiles: () => ipcRenderer.invoke(Invoke.revealProfiles),
  revealLogs: () => ipcRenderer.invoke(Invoke.revealLogs),
  browseHome: (target) => ipcRenderer.invoke(Invoke.browseHome, target),
  copyText: (text: string) => ipcRenderer.invoke(Invoke.copyText, text),
  pasteText: () => ipcRenderer.invoke(Invoke.pasteText),

  saveProfile: (id, draft) => ipcRenderer.invoke(Invoke.saveProfile, id, draft),
  deleteProfile: (id) => ipcRenderer.invoke(Invoke.deleteProfile, id),
  saveServer: (previousName, draft) => ipcRenderer.invoke(Invoke.saveServer, previousName, draft),
  deleteServer: (name) => ipcRenderer.invoke(Invoke.deleteServer, name),
  settingsSnapshot: () => ipcRenderer.invoke(Invoke.settingsSnapshot),
  chooseRealm: () => ipcRenderer.invoke(Invoke.chooseRealm),
  exportCharacter: (id, password) => ipcRenderer.invoke(Invoke.exportCharacter, id, password),
  chooseCharacterFile: () => ipcRenderer.invoke(Invoke.chooseCharacterFile),
  importCharacter: (file) => ipcRenderer.invoke(Invoke.importCharacter, file),
  searchRooms: (session, query) => ipcRenderer.invoke(Invoke.searchRooms, session, query),
  mobNames: (session) => ipcRenderer.invoke(Invoke.mobNames, session),
  worldInfo: (session) => ipcRenderer.invoke(Invoke.worldInfo, session),
  questBook: (session) => ipcRenderer.invoke(Invoke.questBook, session),
  questErrand: (session, block) => ipcRenderer.invoke(Invoke.questErrand, session, block),
  questPlan: (session, block, marked) =>
    ipcRenderer.invoke(Invoke.questPlan, session, block, marked),
  questRun: (session, block, marked) => ipcRenderer.invoke(Invoke.questRun, session, block, marked),
  questStop: (session) => ipcRenderer.invoke(Invoke.questStop, session),
  localMap: (session, map, room, radius) =>
    ipcRenderer.invoke(Invoke.localMap, session, map, room, radius),
  roomBrief: (session, map, room) => ipcRenderer.invoke(Invoke.roomBrief, session, map, room),
  slotGear: (session, slot) => ipcRenderer.invoke(Invoke.slotGear, session, slot),
  huntingGrounds: (session, measure) => ipcRenderer.invoke(Invoke.huntingGrounds, session, measure),
  trainers: (session) => ipcRenderer.invoke(Invoke.trainers, session),
  banks: (session) => ipcRenderer.invoke(Invoke.banks, session),
  itemsServing: (session) => ipcRenderer.invoke(Invoke.itemsServing, session),
  wards: (session) => ipcRenderer.invoke(Invoke.wards, session),
  invokeChoices: (session) => ipcRenderer.invoke(Invoke.invokeChoices, session),
  draftLoop: (session, rooms) => ipcRenderer.invoke(Invoke.draftLoop, session, rooms),
  wearer: (session) => ipcRenderer.invoke(Invoke.wearer, session),
  lookup: (session, query) => ipcRenderer.invoke(Invoke.lookup, session, query),
  forget: (session, discovery) => ipcRenderer.invoke(Invoke.forget, session, discovery),
  forgetFind: (session, find) => ipcRenderer.invoke(Invoke.forgetFind, session, find),
  forgetCharacter: (session) => ipcRenderer.invoke(Invoke.forgetCharacter, session),
  answerLowLives: (session, answer) => ipcRenderer.invoke(Invoke.answerLowLives, session, answer),
  resetStats: (session) => ipcRenderer.invoke(Invoke.resetStats, session),
  names: (session) => ipcRenderer.invoke(Invoke.names, session),
  ask: (session, command) => ipcRenderer.invoke(Invoke.ask, session, command),
  locate: (session) => ipcRenderer.invoke(Invoke.locate, session),
  gear: (session, action, item) => ipcRenderer.invoke(Invoke.gear, session, action, item),
  terminalAct: (session, action) => ipcRenderer.invoke(Invoke.terminalAct, session, action),
  askRemote: (session, who, name) => ipcRenderer.invoke(Invoke.askRemote, session, who, name),

  onData: (handler) => subscribe(Push.data, handler),
  onState: (handler) => subscribe(Push.state, handler),
  onTelnet: (handler) => subscribe(Push.telnet, handler),
  onLine: (handler) => subscribe(Push.line, handler),
  onDebug: (handler) => subscribe(Push.debug, handler),
  onBlock: (handler) => subscribe(Push.block, handler),
  onCharacter: (handler) => subscribe(Push.character, handler),
  onPlayers: (handler) => subscribe(Push.players, handler),
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
  onConfig: (handler) => subscribe(Push.config, handler),
  onInternal: (handler) => subscribe(Push.internal, handler)
};

contextBridge.exposeInMainWorld('mudengineWire', api);
