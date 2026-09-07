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
 * Dependency-free, like everything in `src/shared/`.
 */

/** Where the socket is upgraded, under whatever origin the client is served from. */
export const RPC_PATH = '/ws';

/** A fire-and-forget call: `Send.*`. */
export interface RpcSend {
  k: 'send';
  c: string;
  a: unknown[];
}

/** A request that wants an answer: `Invoke.*`. */
export interface RpcInvoke {
  k: 'invoke';
  id: number;
  c: string;
  a: unknown[];
}

export type RpcRequest = RpcSend | RpcInvoke;

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

export type RpcOutbound = RpcReply | RpcPush;

/**
 * A channel name is a short, fixed string from `ipc.ts`; anything else on the
 * wire is a message nobody declared. The cap is generous against the longest
 * channel there is and tight against a payload smuggled into the name.
 */
const CHANNEL = /^[a-z][a-z0-9:-]{0,63}$/;

function isChannel(value: unknown): value is string {
  return typeof value === 'string' && CHANNEL.test(value);
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a browser tab may say. */
export function asRpcRequest(value: unknown): RpcRequest | null {
  if (!isRecord(value)) return null;
  if (!isChannel(value['c']) || !Array.isArray(value['a'])) return null;
  if (value['k'] === 'send') return { k: 'send', c: value['c'], a: value['a'] };
  if (value['k'] === 'invoke' && isId(value['id'])) {
    return { k: 'invoke', id: value['id'], c: value['c'], a: value['a'] };
  }
  return null;
}

/** What the client may say back. */
export function asRpcOutbound(value: unknown): RpcOutbound | null {
  if (!isRecord(value)) return null;
  if (value['k'] === 'push') {
    if (!isChannel(value['c'])) return null;
    return { k: 'push', c: value['c'], p: value['p'] };
  }
  if (value['k'] === 'reply' && isId(value['id'])) {
    if (typeof value['e'] === 'string') return { k: 'reply', id: value['id'], e: value['e'] };
    return { k: 'reply', id: value['id'], r: value['r'] };
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
