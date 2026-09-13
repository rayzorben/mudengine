/**
 * The only bridge between the sandboxed renderer and the main process.
 *
 * Every method here mirrors an entry in the `IpcApi` contract; subscription
 * helpers return an unsubscribe function so React effects can clean up without
 * leaking listeners across hot reloads.
 *
 * Anything belonging to a session takes its id as the first argument, and every
 * pushed payload arrives as `Addressed<T>`. That is the contract's doing, not a
 * convention observed here — a call that forgets which character it means does
 * not compile.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import {
  Invoke,
  Push,
  Send,
  type Addressed,
  type IpcApi,
  type Notice,
  type SessionId,
  type ProfileSummary,
  type SessionSummary
} from '../shared/ipc';
import type { Block } from '../shared/blocks';
import type { Discovery } from '../shared/memory';
import type { Find } from '../shared/finds';
import type { ResetNotice } from '../shared/ipc';
import type { CharacterState } from '../shared/character';
import type { DebugRecord } from '../shared/debug';
import type { ConfigSnapshot } from '../shared/config';
import type { InternalConfig } from '../shared/internal';
import type { LoopProgress } from '../shared/loops';
import type { WalkProgress } from '../shared/walk';
import type { AutomationSnapshot } from '../shared/automation';
import type { RoomVerdict } from '../shared/verdict';
import type {
  ConnectionState,
  ConnectionTarget,
  StreamChunk,
  StreamLine,
  TelnetEvent,
  TerminalSize
} from '../shared/types';

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: IpcApi = {
  // The preload is only ever Electron's; the web bridge says `web` of itself.
  host: 'electron',

  clientReady: () => ipcRenderer.send(Send.clientReady),
  input: (session: SessionId, data: string) => ipcRenderer.send(Send.input, session, data),
  resize: (session: SessionId, size: TerminalSize) => ipcRenderer.send(Send.resize, session, size),
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
  walkRoute: (session, route) => ipcRenderer.invoke(Invoke.walkRoute, session, route),
  startMoving: (session, loop, confirmed) =>
    ipcRenderer.invoke(Invoke.startMoving, session, loop, confirmed),
  stopMoving: (session) => ipcRenderer.invoke(Invoke.stopMoving, session),
  listLoops: (session) => ipcRenderer.invoke(Invoke.listLoops, session),
  startLoop: (session, name) => ipcRenderer.invoke(Invoke.startLoop, session, name),
  skipLoopStop: (session) => ipcRenderer.invoke(Invoke.skipLoopStop, session),
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

  listSessions: () => ipcRenderer.invoke(Invoke.listSessions),
  listProfiles: () => ipcRenderer.invoke(Invoke.listProfiles),
  loadProfile: (id) => ipcRenderer.invoke(Invoke.loadProfile, id),
  unloadProfile: (id, force) => ipcRenderer.invoke(Invoke.unloadProfile, id, force),
  attach: (session) => ipcRenderer.invoke(Invoke.attach, session),
  detach: (session) => ipcRenderer.invoke(Invoke.detach, session),
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
  searchRooms: (session, query) => ipcRenderer.invoke(Invoke.searchRooms, session, query),
  worldInfo: (session) => ipcRenderer.invoke(Invoke.worldInfo, session),
  questBook: (session) => ipcRenderer.invoke(Invoke.questBook, session),
  localMap: (session, map, room, radius) =>
    ipcRenderer.invoke(Invoke.localMap, session, map, room, radius),
  roomBrief: (session, map, room) => ipcRenderer.invoke(Invoke.roomBrief, session, map, room),
  huntingGrounds: (session, radius) => ipcRenderer.invoke(Invoke.huntingGrounds, session, radius),
  trainers: (session) => ipcRenderer.invoke(Invoke.trainers, session),
  banks: (session) => ipcRenderer.invoke(Invoke.banks, session),
  itemsServing: (session) => ipcRenderer.invoke(Invoke.itemsServing, session),
  draftLoop: (session, rooms) => ipcRenderer.invoke(Invoke.draftLoop, session, rooms),
  wearer: (session) => ipcRenderer.invoke(Invoke.wearer, session),
  lookup: (session, query) => ipcRenderer.invoke(Invoke.lookup, session, query),
  forget: (session, discovery) => ipcRenderer.invoke(Invoke.forget, session, discovery),
  forgetFind: (session, find) => ipcRenderer.invoke(Invoke.forgetFind, session, find),
  forgetCharacter: (session) => ipcRenderer.invoke(Invoke.forgetCharacter, session),
  names: (session) => ipcRenderer.invoke(Invoke.names, session),
  ask: (session, command) => ipcRenderer.invoke(Invoke.ask, session, command),
  gear: (session, action, item) => ipcRenderer.invoke(Invoke.gear, session, action, item),
  terminalAct: (session, action) => ipcRenderer.invoke(Invoke.terminalAct, session, action),
  askRemote: (session, who, name) => ipcRenderer.invoke(Invoke.askRemote, session, who, name),

  onData: (handler) => subscribe<Addressed<StreamChunk>>(Push.data, handler),
  onState: (handler) => subscribe<Addressed<ConnectionState>>(Push.state, handler),
  onTelnet: (handler) => subscribe<Addressed<TelnetEvent>>(Push.telnet, handler),
  onLine: (handler) => subscribe<Addressed<StreamLine>>(Push.line, handler),
  onDebug: (handler) => subscribe<Addressed<DebugRecord>>(Push.debug, handler),
  onBlock: (handler) => subscribe<Addressed<Block>>(Push.block, handler),
  onCharacter: (handler) => subscribe<Addressed<CharacterState>>(Push.character, handler),
  onWalk: (handler) => subscribe<Addressed<WalkProgress>>(Push.walk, handler),
  onLoop: (handler) => subscribe<Addressed<LoopProgress>>(Push.loop, handler),
  onAutomation: (handler) => subscribe<Addressed<AutomationSnapshot>>(Push.automation, handler),
  onVerdict: (handler) => subscribe<Addressed<RoomVerdict>>(Push.verdict, handler),
  onNotice: (handler) => subscribe<Notice>(Push.notice, handler),
  onSessions: (handler) => subscribe<SessionSummary[]>(Push.sessions, handler),
  onProfiles: (handler) => subscribe<ProfileSummary[]>(Push.profiles, handler),
  onLearned: (handler) => subscribe<Addressed<Discovery[]>>(Push.learned, handler),
  onFinds: (handler) => subscribe<Addressed<Find[]>>(Push.finds, handler),
  onCharacterReset: (handler) => subscribe<Addressed<ResetNotice>>(Push.characterReset, handler),
  onQuestSaid: (handler) => subscribe<Addressed<Record<number, number>>>(Push.questSaid, handler),
  onConfig: (handler) => subscribe<ConfigSnapshot>(Push.config, handler),
  onInternal: (handler) => subscribe<InternalConfig>(Push.internal, handler)
};

contextBridge.exposeInMainWorld('mudengine', api);
