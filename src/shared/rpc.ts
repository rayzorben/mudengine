/**
 * The web transport's wire: what a browser tab and the client say to each
 * other over one WebSocket.
 *
 * The desktop client carries `IpcApi` over Electron's IPC, and the preload is
 * the bridge. In web mode the same contract — the same `Send`, `Invoke` and
 * `Push` channels, the same payloads — crosses a socket instead, and this is
 * the envelope it crosses in. Deliberately tiny: a message names its kind, its
 * channel and its arguments, and nothing else, so the two bridges (`preload/
 * index.ts` and `renderer/src/lib/webBridge.ts`) can be the same object literal
 * over two carriers and `ipc-wiring.test.ts` can hold both to the one list.
 *
 * Parsed, never trusted, in both directions: a browser tab is a client like
 * any other and a server is a peer like any other, and `asRpcRequest` /
 * `asRpcOutbound` return the typed message or `null` — the rule `asRoute` and
 * `asConnectionTarget` already keep at the boundary where bytes become calls.
 *
 * A tab outlives its socket (`main/host/web/link.ts`): what the client sends
 * is numbered (`n`) and held until the tab acknowledges it (`RpcAck`), what
 * the tab sends is numbered (`q`) and taken once, and a tab that dials again
 * names itself (`RpcHello`) and is sent what it missed (`RpcWelcome`).
 *
 * Dependency-free, like everything in `src/shared/`.
 */

/** Where the socket is upgraded, under whatever origin the client is served from. */
export const RPC_PATH = '/ws';

/** A tab gave a socket up as dead; the client keeps the tab for it to come back. */
export const GAVE_UP = 4000;
/** The page is going away; the client lets the tab go at once. */
export const PAGE_CLOSED = 4001;

/** A fire-and-forget call: `Send.*`. `q` numbers it among everything the tab sends. */
export interface RpcSend {
  k: 'send';
  q: number;
  c: string;
  a: unknown[];
}

/** A request that wants an answer: `Invoke.*`. */
export interface RpcInvoke {
  k: 'invoke';
  q: number;
  id: number;
  c: string;
  a: unknown[];
}

export type RpcRequest = RpcSend | RpcInvoke;

/**
 * The first thing a tab says on a socket: the tab it was (`tab` and its
 * `key`, both null on its first socket) and the last message it has.
 */
export interface RpcHello {
  k: 'hello';
  tab: number | null;
  key: string | null;
  last: number;
}

/** The tab has every message up to `n`; the client may stop holding them. */
export interface RpcAck {
  k: 'ack';
  n: number;
}

export type RpcInbound = RpcRequest | RpcHello | RpcAck;

/** An invoke answered. */
export interface RpcResult {
  k: 'reply';
  id: number;
  r: unknown;
}

/** An invoke refused: the handler threw, or nothing handles the channel. */
export interface RpcFailure {
  k: 'reply';
  id: number;
  e: string;
}

export type RpcReply = RpcResult | RpcFailure;

/** Main speaking first: `Push.*`. */
export interface RpcPush {
  k: 'push';
  c: string;
  p: unknown;
}

/** What main says to a tab, before it is numbered for the wire. */
export type RpcOutbound = RpcReply | RpcPush;

/** A message as it crosses: `n` is its place among everything sent to the tab. */
export type RpcNumbered = RpcOutbound & { n: number };

/**
 * The answer to a hello. `resumed` is the same window brought up to date, its
 * missed messages following; otherwise the tab is a new window to main and
 * holds nothing it had. `got` is the last request taken.
 */
export interface RpcWelcome {
  k: 'welcome';
  tab: number;
  key: string;
  resumed: boolean;
  got: number;
}

/**
 * The client is still there, sent to every tab each ping sweep. A browser
 * answers a WebSocket ping without telling the page, and a socket a sleep or
 * a network change killed can look open to the tab for minutes; a tab that
 * has heard nothing for two beats (`next` is the gap to the next one) dials
 * again. `got` is the last request taken.
 */
export interface RpcBeat {
  k: 'beat';
  next: number;
  got: number;
}

export type RpcFrame = RpcNumbered | RpcWelcome | RpcBeat;

const CHANNEL = /^[a-z][a-z0-9:-]{0,63}$/;

function isChannel(value: unknown): value is string {
  return typeof value === 'string' && CHANNEL.test(value);
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** A count that may still be zero: nothing sent, nothing taken. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a browser tab may say. */
export function asRpcInbound(value: unknown): RpcInbound | null {
  if (!isRecord(value)) return null;
  if (value['k'] === 'hello') {
    const { tab, key, last } = value;
    if (!isCount(last)) return null;
    if (tab === null && key === null) return { k: 'hello', tab: null, key: null, last };
    if (!isId(tab) || typeof key !== 'string' || key.length === 0) return null;
    return { k: 'hello', tab, key, last };
  }
  if (value['k'] === 'ack') return isCount(value['n']) ? { k: 'ack', n: value['n'] } : null;
  if (!isId(value['q']) || !isChannel(value['c']) || !Array.isArray(value['a'])) return null;
  if (value['k'] === 'send') return { k: 'send', q: value['q'], c: value['c'], a: value['a'] };
  if (value['k'] === 'invoke' && isId(value['id'])) {
    return { k: 'invoke', q: value['q'], id: value['id'], c: value['c'], a: value['a'] };
  }
  return null;
}

/** What the client may say back. */
export function asRpcFrame(value: unknown): RpcFrame | null {
  if (!isRecord(value)) return null;
  if (value['k'] === 'welcome') {
    const { tab, key, resumed, got } = value;
    if (!isId(tab) || typeof key !== 'string' || typeof resumed !== 'boolean' || !isCount(got)) {
      return null;
    }
    return { k: 'welcome', tab, key, resumed, got };
  }
  if (value['k'] === 'beat') {
    const { next, got } = value;
    if (typeof next !== 'number' || !Number.isFinite(next) || next <= 0 || !isCount(got)) {
      return null;
    }
    return { k: 'beat', next, got };
  }
  const n = value['n'];
  if (!isId(n)) return null;
  if (value['k'] === 'push') {
    if (!isChannel(value['c'])) return null;
    return { k: 'push', n, c: value['c'], p: value['p'] };
  }
  if (value['k'] === 'reply' && isId(value['id'])) {
    if (typeof value['e'] === 'string') return { k: 'reply', n, id: value['id'], e: value['e'] };
    return { k: 'reply', n, id: value['id'], r: value['r'] };
  }
  return null;
}

/**
 * The arguments as JSON will carry them.
 *
 * Electron's IPC is a structured clone, so an optional parameter left out
 * arrives as `undefined` and a handler asking `target === undefined` reads it
 * as absent. JSON has no `undefined`: it becomes `null` inside an array, and
 * the same handler would then parse `null` as a target and refuse it. Every
 * optional parameter in `IpcApi` is a trailing one, so dropping the trailing
 * `undefined`s is what keeps the two carriers meaning the same thing.
 */
export function trimArgs(args: readonly unknown[]): unknown[] {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end -= 1;
  return args.slice(0, end);
}
