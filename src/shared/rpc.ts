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
 * Dependency-free, like everything in `src/shared/`, but for `ipc.ts`'s names.
 */
import { Push } from './ipc';

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

/**
 * How the tab has fared since its last report, sent every `webReportMs` and
 * written to `logs/web.log`: what the player felt is in the browser, where
 * the client cannot see it. Times are milliseconds.
 */
export interface TabHealthFigures {
  /** What this report covers. */
  periodMs: number;
  visible: boolean;
  /** Main-thread tasks over 50 ms (the browser's long tasks). */
  longTasks: number;
  longTaskMs: number;
  longestTaskMs: number;
  /** Keys pressed, those over 100 ms from press to paint, and the slowest. */
  keys: number;
  slowKeys: number;
  slowestKeyMs: number;
  /** The most a one-second timer ran late: the thread was busy or paused. */
  timerLagMs: number;
  /** Each socket that closed, as `code@seconds into the period`. */
  closes: string[];
  /** Time with no linked socket, comebacks as the same window, and new windows. */
  downMs: number;
  resumes: number;
  renewals: number;
  /** Messages taken and their characters. */
  frames: number;
  chars: number;
}

/** The most closes one report lists, and the longest each may be. */
export const REPORT_CLOSES = 50;
export const REPORT_CLOSE_CHARS = 40;

export interface RpcReport extends TabHealthFigures {
  k: 'report';
}

export type RpcInbound = RpcRequest | RpcHello | RpcAck | RpcReport;

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

/**
 * A push sent as what changed (`main/host/web/patches.ts`): the top-level
 * fields of `s`'s payload that differ from the last one this tab was sent on
 * `c`, and those it no longer has. The tab puts the payload back together.
 */
export interface RpcPatch {
  k: 'patch';
  c: string;
  s: string;
  set: Record<string, unknown>;
  drop: string[];
}

/** The pushes sent to a browser tab as patches: each a whole state per character, mostly unchanged. */
export const PATCHED_PUSHES: ReadonlySet<string> = new Set([Push.character, Push.automation]);

/** A message as it crosses: `n` is its place among everything sent to the tab. */
export type RpcNumbered = (RpcOutbound | RpcPatch) & { n: number };

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
  /** The client's build (`buildId`): a page holding another build's code loads this one. */
  build: string | null;
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
  if (value['k'] === 'report') return asReport(value);
  if (!isId(value['q']) || !isChannel(value['c']) || !Array.isArray(value['a'])) return null;
  if (value['k'] === 'send') return { k: 'send', q: value['q'], c: value['c'], a: value['a'] };
  if (value['k'] === 'invoke' && isId(value['id'])) {
    return { k: 'invoke', q: value['q'], id: value['id'], c: value['c'], a: value['a'] };
  }
  return null;
}

const REPORT_COUNTS = [
  'periodMs',
  'longTasks',
  'longTaskMs',
  'longestTaskMs',
  'keys',
  'slowKeys',
  'slowestKeyMs',
  'timerLagMs',
  'downMs',
  'resumes',
  'renewals',
  'frames',
  'chars'
] as const satisfies ReadonlyArray<keyof TabHealthFigures>;

/** A figure a browser measured: finite and not negative; the caller rounds it. */
function isMeasure(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function asReport(value: Record<string, unknown>): RpcReport | null {
  const closes = value['closes'];
  if (typeof value['visible'] !== 'boolean' || !Array.isArray(closes)) return null;
  if (closes.length > REPORT_CLOSES) return null;
  if (!closes.every((close) => typeof close === 'string' && close.length <= REPORT_CLOSE_CHARS)) {
    return null;
  }
  const counts: Partial<Record<(typeof REPORT_COUNTS)[number], number>> = {};
  for (const name of REPORT_COUNTS) {
    const measured = value[name];
    if (!isMeasure(measured)) return null;
    counts[name] = Math.round(measured);
  }
  return {
    k: 'report',
    ...(counts as Record<(typeof REPORT_COUNTS)[number], number>),
    visible: value['visible'],
    closes: closes as string[]
  };
}

/** What the client may say back. */
export function asRpcFrame(value: unknown): RpcFrame | null {
  if (!isRecord(value)) return null;
  if (value['k'] === 'welcome') {
    const { tab, key, resumed, got, build } = value;
    if (!isId(tab) || typeof key !== 'string' || typeof resumed !== 'boolean' || !isCount(got)) {
      return null;
    }
    if (build !== null && typeof build !== 'string') return null;
    return { k: 'welcome', tab, key, resumed, got, build };
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
  if (value['k'] === 'patch') {
    const { c, s, set, drop } = value;
    if (!isChannel(c) || typeof s !== 'string' || !isRecord(set) || !Array.isArray(drop))
      return null;
    if (!drop.every((field) => typeof field === 'string')) return null;
    return { k: 'patch', n, c, s, set, drop: drop as string[] };
  }
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
