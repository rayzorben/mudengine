/**
 * The sharer's half of remote control as a whole window (todo
 * 20261031-1156-01): each player controlling one of this install's
 * characters is a window here, registered with the window registry and
 * attached to that character when it asks, so it is pushed what the
 * character's own window is pushed. Its calls arrive over the gateway and run
 * through the same handlers a window's do, each read against `peerRelay.ts`
 * again: a call that names anything but the shared character, or a channel
 * the rule does not forward, is refused. What it is pushed is filtered to the
 * shared character and sent as what changed (`PushPatcher`), in parts.
 *
 * A line the controller types is held up to its Enter (`Typed`): one that
 * logs the character off, deletes it or passes an `@` command on is erased
 * from the realm's line, refused and written to the safety trace.
 */
import { macroLines } from '../../shared/macro';
import type { SafetyDecision } from '../../shared/automation';
import { Invoke, Send, type SessionId } from '../../shared/ipc';
import {
  nextRelayNumber,
  readRelayMessage,
  relayAllows,
  relayParts,
  RELAY_MOST_MESSAGE_CHARS,
  relayPushCrosses,
  relayRule,
  RelayJoin,
  SHARED_SESSION
} from '../../shared/peerRelay';
import { peerKeyText, type PeerKey } from '../../shared/peers';
import type { Listener, RelayPart } from '../../shared/peerWire';
import { asRpcInbound, type RpcPush, type RpcReply } from '../../shared/rpc';
import { errorMessage, isRecord } from '../../shared/values';
import { t } from '../app/i18n';
import type { Caller } from '../host/Host';
import { PushPatcher } from '../host/web/patches';
import type { WindowRegistry } from '../windows/WindowRegistry';
import { editorInput } from '../session/editorInput';
import type { PeerLink } from './PeerLink';
import type { HandlerTable } from './relayTransport';

/** Above any window or browser tab id, so a controller is never taken for either. */
const FIRST_RELAY_WINDOW = 1_000_000_000;

export interface RelayDeskDeps {
  handlers: HandlerTable;
  windows: Pick<WindowRegistry, 'add' | 'remove'>;
  link: Pick<PeerLink, 'feed'>;
  /** Why the line `by` typed into `id`'s terminal is not sent, or null to send it. */
  screen(id: SessionId, line: string, by: string): string | null;
  notice(id: SessionId, message: string): void;
  refused(id: SessionId, decision: SafetyDecision): void;
  /** The client's log, for a call that could not be read. */
  say(message: string): void;
  now(): number;
}

/** One controller of one character. */
interface Relay {
  readonly windowId: number;
  readonly session: SessionId;
  readonly peer: PeerKey;
  readonly by: Listener;
  readonly join: RelayJoin;
  readonly patcher: PushPatcher;
  /** What the controller has typed since its last Enter, as the realm's line holds it. */
  typed: string;
  /** The next message's number; the controller reads it as a frame number, from 1. */
  next: number;
  open: boolean;
}

const keyOf = (peer: PeerKey, by: Listener): string =>
  `${peerKeyText(peer)}\u0000${by.name}\u0000${by.key}`;

export class RelayDesk {
  private readonly relays = new Map<string, Relay>();
  private nextWindow = FIRST_RELAY_WINDOW;

  constructor(private readonly deps: RelayDeskDeps) {}

  /** `by` controls `session` now: a window for it. */
  open(session: SessionId, peer: PeerKey, by: Listener): void {
    const key = keyOf(peer, by);
    if (this.relays.has(key)) return;
    const relay: Relay = {
      windowId: this.nextWindow,
      session,
      peer,
      by,
      join: new RelayJoin(),
      patcher: new PushPatcher(),
      typed: '',
      next: 1,
      open: true
    };
    this.nextWindow += 1;
    this.relays.set(key, relay);
    this.deps.windows.add({
      id: relay.windowId,
      isDestroyed: () => !relay.open,
      send: (channel, payload) => this.pushed(relay, channel, payload)
    });
  }

  /** `by` no longer controls the character `peer` claims: its window goes. */
  close(peer: PeerKey, by: Listener): void {
    const key = keyOf(peer, by);
    const relay = this.relays.get(key);
    if (relay === undefined) return;
    relay.open = false;
    this.relays.delete(key);
    this.deps.windows.remove(relay.windowId);
  }

  /** Every controller of `session`, or of every character for null, goes. */
  closeAll(session: SessionId | null): void {
    for (const relay of [...this.relays.values()]) {
      if (session === null || relay.session === session) this.close(relay.peer, relay.by);
    }
  }

  /** Whether `windowId` is a controller's window on `session`: typing from it is the character's own. */
  isRelayWindow(windowId: number, session: SessionId): boolean {
    for (const relay of this.relays.values()) {
      if (relay.windowId === windowId && relay.session === session) return true;
    }
    return false;
  }

  /** One part of a call from `by` to the character `peer` claims. */
  heard(peer: PeerKey, by: Listener, part: RelayPart): void {
    const relay = this.relays.get(keyOf(peer, by));
    // The gateway admits a call only from a watcher, and `ControlDesk` decides who that is.
    if (relay === undefined) return;
    const text = relay.join.take(part);
    if (text === null) return;
    if (text === 'too-long') {
      this.deps.say(`remote control: a call from ${by.name} was too long, and dropped`);
      return;
    }
    const message = readRelayMessage(text, asRpcInbound);
    if (message === null || (message.k !== 'invoke' && message.k !== 'send')) {
      this.deps.say(`remote control: a call from ${by.name} did not read, and was dropped`);
      return;
    }
    if (message.k === 'send') this.send(relay, message.c, message.a);
    else void this.invoke(relay, message.id, message.c, message.a);
  }

  private caller(relay: Relay): Caller {
    return {
      windowId: relay.windowId,
      send: (channel, payload) => this.pushed(relay, channel, payload)
    };
  }

  /** The arguments with the shared character in its place, or the refusal. */
  private placed(
    relay: Relay,
    kind: 'invoke' | 'send',
    channel: string,
    args: readonly unknown[]
  ): unknown[] | string {
    const rule = relayRule(kind, channel);
    if (rule.kind !== 'forward' || args[rule.at] !== SHARED_SESSION || !relayAllows(rule, args)) {
      // The channel is the log's; the player is told it is the character's own player's to do.
      this.deps.say(`remote control: ${relay.by.name} asked for ${channel}, which is not relayed`);
      return t('peers.relay.refused');
    }
    const placed = [...args];
    placed[rule.at] = relay.session;
    return placed;
  }

  private send(relay: Relay, channel: string, args: readonly unknown[]): void {
    const placed = this.placed(relay, 'send', channel, args);
    if (typeof placed === 'string') return this.refuse(relay, placed);
    if (channel === Send.input && typeof placed[1] === 'string') {
      const keys = this.typedInput(relay, placed[1]);
      if (keys.length === 0) return;
      placed[1] = keys;
    }
    if (channel === Send.macro && typeof placed[1] === 'string') {
      const refused = this.firstRefused(
        relay,
        macroLines(placed[1]).map((each) => each.command),
        relay.typed
      );
      if (refused !== null) return this.refuse(relay, refused);
    }
    void this.deps.handlers.handler('send', channel)?.(this.caller(relay), ...placed);
  }

  private async invoke(
    relay: Relay,
    id: number,
    channel: string,
    args: readonly unknown[]
  ): Promise<void> {
    const placed = this.placed(relay, 'invoke', channel, args);
    const answer = (reply: RpcReply): void => this.feed(relay, { ...reply });
    if (typeof placed === 'string') {
      this.refuse(relay, placed);
      return answer({ k: 'reply', id, e: placed });
    }
    if (channel === Invoke.ask && typeof placed[1] === 'string') {
      const refused = this.firstRefused(relay, [placed[1]], relay.typed);
      if (refused !== null) {
        this.refuse(relay, refused);
        return answer({ k: 'reply', id, e: refused });
      }
    }
    const handler = this.deps.handlers.handler('invoke', channel);
    if (handler === undefined) return answer({ k: 'reply', id, e: t('peers.relay.refused') });
    try {
      answer({ k: 'reply', id, r: await handler(this.caller(relay), ...placed) });
    } catch (error) {
      answer({ k: 'reply', id, e: errorMessage(error) });
    }
  }

  /**
   * The keys as they go to the realm: each line the controller ends with Enter
   * is screened whole, and one refused is erased from the realm's line instead.
   */
  private typedInput(relay: Relay, data: string): string {
    let out = '';
    let from = 0;
    for (let at = 0; at < data.length; at += 1) {
      const ch = data[at]!;
      if (ch !== '\r' && ch !== '\n') continue;
      const before = data.slice(from, at);
      this.keep(relay, before);
      out += before;
      // A CR LF pair is one Enter.
      const end = ch === '\r' && data[at + 1] === '\n' ? at + 2 : at + 1;
      const refused = this.firstRefused(relay, [relay.typed]);
      if (refused === null) out += data.slice(at, end);
      else {
        out += '\b'.repeat(relay.typed.length);
        this.refuse(relay, refused);
      }
      relay.typed = '';
      from = end;
      at = end - 1;
    }
    const rest = data.slice(from);
    this.keep(relay, rest);
    return out + rest;
  }

  /** `keys` applied to what the controller has typed, as the realm's line editor applies them. */
  private keep(relay: Relay, keys: string): void {
    for (const ch of editorInput(keys)) {
      if (ch === '\b' || ch === '\x7f') relay.typed = relay.typed.slice(0, -1);
      else relay.typed += ch;
    }
  }

  /**
   * The first of `lines` refused, or null. `typed` is what the controller has
   * typed into the realm's line without an Enter: the first line goes out on
   * the end of it, so `qui` typed and `t` sent is `quit`.
   */
  private firstRefused(relay: Relay, lines: readonly string[], typed = ''): string | null {
    for (const [at, line] of lines.entries()) {
      const whole = (at === 0 ? typed + line : line).trim();
      if (whole.length === 0) continue;
      const why = this.deps.screen(relay.session, whole, relay.by.name);
      if (why !== null) return why;
    }
    return null;
  }

  /** Said in the character's console and its safety trace. */
  private refuse(relay: Relay, why: string): void {
    const from = relay.by.name;
    this.deps.notice(relay.session, t('peers.control.refused', { from, why }));
    this.deps.refused(relay.session, {
      at: this.deps.now(),
      action: t('peers.control.action'),
      because: t('peers.control.because', { from }),
      acted: false,
      refused: why
    });
  }

  /** A push the registry sends this controller's window: only what is about the shared character crosses. */
  private pushed(relay: Relay, channel: string, payload: unknown): void {
    if (!relay.open || !relayPushCrosses(channel)) return;
    if (!isRecord(payload) || payload['session'] !== relay.session) return;
    const message: RpcPush = { k: 'push', c: channel, p: { ...payload, session: SHARED_SESSION } };
    const patched = relay.patcher.patch(message);
    switch (patched.k) {
      case 'same':
        return;
      case 'whole':
        return this.feed(relay, message);
      case 'patch':
        return this.feedText(relay, (n) => `{"n":${n},${patched.body}`);
      default: {
        const never: never = patched;
        return never;
      }
    }
  }

  private feed(relay: Relay, message: RpcPush | RpcReply): void {
    // Written once, the number put in front, as a patch is.
    const body = JSON.stringify(message).slice(1);
    if (body.length <= RELAY_MOST_MESSAGE_CHARS)
      return this.feedText(relay, (n) => `{"n":${n},${body}`);
    if (message.k === 'reply') {
      const e = t('peers.relay.tooLarge');
      return this.feedText(relay, (n) => JSON.stringify({ n, k: 'reply', id: message.id, e }));
    }
    this.deps.say(`remote control: a ${message.c} push for ${relay.by.name} was too large to send`);
  }

  private feedText(relay: Relay, text: (n: number) => string): void {
    const n = relay.next;
    relay.next = nextRelayNumber(n);
    for (const part of relayParts(n, text(n))) this.deps.link.feed(relay.peer, relay.by, part);
  }
}
