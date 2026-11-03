/**
 * This install's one socket to the sharing gateway (todo 20261031-1156-01).
 * It is open only while some character needs it (a share on, the user's
 * answer of 2026-11-02), and dialled again with a doubling wait after a loss.
 * Each socket says a signed hello, then claims each character by answering
 * the gateway's challenge with that character's key, then sends its share
 * list. A character's sheet goes out only while the gateway says somebody
 * listens (`audience`): whole first, then the fields that changed, and an
 * empty change every `freshEveryMs` so a receiver can tell a quiet sharer
 * from a lost one. What the gateway relays from other sharers goes to
 * `heard`; a loss of the socket is `lost`, so nothing stays at its last value.
 * Remote control's frames go out through `watch`, `sendAction`, `text`, `answer` and
 * `release`, and come in to `controlled` (as the sharer) and `controlling`.
 */
import { createHmac } from 'node:crypto';

import type { Ed25519Pair } from '../../node/ed25519';
import type { WebSocketConnection } from '../../node/sockets';
import { peerKeyText, type PeerKey, type PeerSheet, type ShareLink } from '../../shared/peers';
import {
  asPeerDown,
  claimText,
  isUnknownKind,
  PEER_DOWN_KINDS,
  helloText,
  PEER_PATHS,
  REFUSALS_THAT_CLOSE,
  type PeerDown,
  type PeerToken,
  type PeerUp,
  type Listener,
  type RefusedWhy,
  type ShareEntry
} from '../../shared/peerWire';
import { errorMessage, sameJson } from '../../shared/values';
import type { BookFrame } from './PeerBook';
import { sentOf, sheetChange, type SentSheet } from './peerSheet';

/** A character this install claims: its key, its pair, and who it shares with. */
export interface Claimant {
  readonly peer: PeerKey;
  readonly pair: Ed25519Pair;
  readonly shares: readonly ShareEntry[];
}

/** The control frames a sharer is sent. */
export type ControlledFrame = Extract<PeerDown, { k: 'controllers' | 'act' }>;
/** The control frames a controller is sent. */
export type ControllingFrame = Extract<PeerDown, { k: 'text' | 'acted' | 'released' }>;

/** A character another install shares, by its claim and key. */
export interface Watched {
  readonly from: PeerKey;
  readonly key: string;
}

/** The socket as the link drives it. */
export type PeerSocket = Pick<
  WebSocketConnection,
  'send' | 'close' | 'ping' | 'onMessage' | 'onClose' | 'onPong'
>;

export interface PeerLinkLimits {
  retryLeastMs: number;
  retryMostMs: number;
  pingEveryMs: number;
  freshEveryMs: number;
}

/** The kept token, as `artToken.ts` keeps the art server's. */
export interface PeerTokens {
  read(): Promise<PeerToken | null>;
  write(token: PeerToken): Promise<void>;
  forget(): Promise<void>;
}

export interface PeerLinkDeps {
  /** The gateway's address, `https://`, read through: the setting is hot-reloaded. */
  server(): string;
  limits(): PeerLinkLimits;
  tokens: PeerTokens;
  register(server: string): Promise<PeerToken>;
  dial(url: string): Promise<PeerSocket>;
  sign(pair: Ed25519Pair, text: string): string;
  /** `bytes` random bytes as hex. */
  random(bytes: number): string;
  now(): number;
  /** Another player's share, sheet, change or leaving. */
  heard(frame: BookFrame): void;
  /** The gateway welcomed this install. */
  linked(): void;
  /** The socket is gone, and everything it carried. */
  lost(): void;
  /** A claim of a name `peer` shares with, under a key its grant does not hold. */
  unpinned(peer: PeerKey, name: string, key: string): void;
  /** Who is controlling one of this install's characters, or an action one of them sent it. */
  controlled(frame: ControlledFrame): void;
  /** The terminal text, an answer or the end of a character this install is controlling. */
  controlling(frame: ControllingFrame): void;
  /** What went wrong, said once until something else does. */
  say(message: string): void;
}

interface Held {
  claimant: Claimant;
  claimed: boolean;
  listening: boolean;
  latest: PeerSheet | null;
  /** What the gateway holds of the sheet, or null when it holds none. */
  sent: SentSheet | null;
  sentAt: number;
  /** The character this one is controlling, watched again on each claim. */
  watching: Watched | null;
}

const EMPTY_CHANGE = { set: {}, deep: {}, drop: [] };

/** What each refusal means, as the player reads it. */
const REFUSED: Record<RefusedWhy, string> = {
  'unknown-token': 'the sharing server no longer knows this client, so it registers again',
  signature: "the sharing server did not accept this client's hello",
  replaced: 'this client opened a second link, which replaced the first',
  'over-limit': 'this client sent more than the sharing server takes',
  malformed: 'the sharing server could not read what this client sent',
  'not-claimed': 'the sharing server was sent a character it had not been told of',
  'no-sheet': 'the sharing server was sent a change before the sheet',
  'not-shared':
    'the sharing server was sent an action for a character that gives no remote control',
  'unknown-frame': 'the sharing server does not read something this client sent, and ignored it'
};

export class PeerLink {
  private readonly held = new Map<string, Held>();
  private socket: PeerSocket | null = null;
  private welcomed = false;
  private dialling = false;
  private disposed = false;
  private retryMs: number | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private answered = true;
  private lastSaid: string | null = null;
  private lastPing = 0;

  constructor(private readonly deps: PeerLinkDeps) {}

  /** The characters to claim now. None closes the socket; some opens it. */
  want(claimants: readonly Claimant[]): void {
    if (this.disposed) return;
    const next = new Map(claimants.map((claimant) => [peerKeyText(claimant.peer), claimant]));
    for (const [id, held] of this.held) {
      const wanted = next.get(id);
      if (wanted !== undefined && wanted.pair.publicKey === held.claimant.pair.publicKey) continue;
      if (held.claimed) this.send({ k: 'leave', peer: held.claimant.peer });
      this.held.delete(id);
    }
    for (const [id, claimant] of next) {
      const held = this.held.get(id);
      if (held === undefined) {
        this.held.set(id, {
          claimant,
          claimed: false,
          listening: false,
          latest: null,
          sent: null,
          sentAt: 0,
          watching: null
        });
        if (this.welcomed) this.claim(claimant);
        continue;
      }
      const changed = !sameJson(held.claimant.shares, claimant.shares);
      held.claimant = claimant;
      if (changed && held.claimed) this.sendShares(held);
    }
    this.settle();
  }

  /** Whether the socket is open, being dialled, or not wanted. */
  get link(): ShareLink {
    if (this.held.size === 0) return 'off';
    return this.welcomed ? 'connected' : 'connecting';
  }

  /** A character's sheet now; sent if somebody listens. */
  observe(peer: PeerKey, sheet: PeerSheet): void {
    const held = this.held.get(peerKeyText(peer));
    if (held === undefined) return;
    held.latest = sheet;
    this.push(held);
  }

  /** Watch `watched`'s terminal as `peer`, or stop (null); kept across reconnects. */
  watch(peer: PeerKey, watched: Watched | null): void {
    const held = this.held.get(peerKeyText(peer));
    if (held === undefined) return;
    const was = held.watching;
    held.watching = watched;
    if (!held.claimed) return;
    if (was !== null && (watched === null || !sameJson(was, watched))) {
      this.send({ k: 'watch', peer, ...was, on: false });
    }
    if (watched !== null) this.send({ k: 'watch', peer, ...watched, on: true });
  }

  /** An action `peer` sends the character it watches; false when no link carries it now. */
  sendAction(peer: PeerKey, id: number, action: Record<string, unknown>): boolean {
    const held = this.held.get(peerKeyText(peer));
    if (held?.claimed !== true || held.watching === null) return false;
    this.send({ k: 'act', peer, ...held.watching, id, action });
    return true;
  }

  /** `peer`'s terminal text, to every controller or to `to` alone. */
  text(peer: PeerKey, text: string, to: Listener | null): void {
    if (this.held.get(peerKeyText(peer))?.claimed === true)
      this.send({ k: 'text', peer, text, to });
  }

  /** `peer`'s answer to one controller's action. */
  answer(peer: PeerKey, to: Listener, id: number, answer: Record<string, unknown>): void {
    if (this.held.get(peerKeyText(peer))?.claimed === true) {
      this.send({ k: 'acted', peer, to, id, answer });
    }
  }

  /** `peer`'s player ends `to`'s control. */
  release(peer: PeerKey, to: Listener): void {
    if (this.held.get(peerKeyText(peer))?.claimed === true) this.send({ k: 'release', peer, to });
  }

  dispose(): void {
    this.disposed = true;
    this.held.clear();
    this.stopRetry();
    if (this.beat !== null) clearInterval(this.beat);
    this.beat = null;
    this.socket?.close(1000, 'client closing');
  }

  /** Open while somebody is claimed or wanted; closed otherwise. */
  private settle(): void {
    if (this.disposed) return;
    if (this.held.size === 0) {
      this.stopRetry();
      this.retryMs = null;
      this.socket?.close(1000, 'nothing shared');
      return;
    }
    if (this.socket === null && !this.dialling && this.retry === null) void this.dial();
  }

  private async dial(): Promise<void> {
    this.dialling = true;
    try {
      const server = this.deps.server();
      let token = await this.deps.tokens.read();
      if (token === null) {
        token = await this.deps.register(server);
        await this.deps.tokens.write(token);
      }
      const socket = await this.deps.dial(server.replace(/^http/, 'ws') + PEER_PATHS.stream);
      if (this.disposed || this.held.size === 0) {
        socket.close(1000, 'nothing shared');
        return;
      }
      this.attach(socket, token);
    } catch (error) {
      this.tell(`the sharing server could not be reached: ${errorMessage(error)}`);
      this.again();
    } finally {
      this.dialling = false;
    }
  }

  private attach(socket: PeerSocket, token: PeerToken): void {
    this.socket = socket;
    this.answered = true;
    socket.onMessage = (text) => this.heard(text);
    socket.onPong = () => {
      this.answered = true;
    };
    socket.onClose = () => this.closed(socket);
    const time = Math.floor(this.deps.now() / 1000);
    const nonce = this.deps.random(16);
    const sig = createHmac('sha256', token.secret).update(helloText(time, nonce)).digest('hex');
    this.send({ k: 'hello', token: token.token, time, nonce, sig });
    const { pingEveryMs, freshEveryMs } = this.deps.limits();
    this.beat = setInterval(() => this.tick(), Math.min(pingEveryMs, freshEveryMs));
    this.beat.unref?.();
  }

  /** The ping, every `pingEveryMs`, and each listened-to sheet kept fresh. */
  private tick(): void {
    const now = this.deps.now();
    const { pingEveryMs, freshEveryMs } = this.deps.limits();
    if (now - this.lastPing >= pingEveryMs) {
      if (!this.answered) {
        this.socket?.close(1001, 'no answer to ping');
        return;
      }
      this.answered = false;
      this.lastPing = now;
      this.socket?.ping();
    }
    for (const held of this.held.values()) {
      if (!held.listening || held.sent === null || now - held.sentAt < freshEveryMs) continue;
      this.send({ k: 'patch', peer: held.claimant.peer, ...EMPTY_CHANGE });
      held.sentAt = now;
    }
  }

  private closed(socket: PeerSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.welcomed = false;
    if (this.beat !== null) clearInterval(this.beat);
    this.beat = null;
    for (const held of this.held.values()) {
      held.claimed = false;
      held.listening = false;
      held.sent = null;
    }
    if (this.disposed) return;
    this.deps.lost();
    if (this.held.size > 0) this.again();
  }

  /** Dial again after the doubling wait. */
  private again(): void {
    if (this.disposed || this.held.size === 0 || this.retry !== null) return;
    const { retryLeastMs, retryMostMs } = this.deps.limits();
    this.retryMs = Math.min(retryMostMs, this.retryMs === null ? retryLeastMs : this.retryMs * 2);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.settle();
    }, this.retryMs);
    this.retry.unref?.();
  }

  private stopRetry(): void {
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
  }

  private heard(text: string): void {
    let value: unknown = null;
    try {
      value = JSON.parse(text);
    } catch {
      // Not JSON: told below as a frame that does not read.
    }
    const frame = asPeerDown(value);
    if (frame === null) {
      this.tell(
        isUnknownKind(value, PEER_DOWN_KINDS)
          ? 'the sharing server sent a kind of message from a newer build, and it was ignored'
          : 'the sharing server sent something this build does not read, and it was ignored'
      );
      return;
    }
    this.act(frame);
  }

  private act(frame: PeerDown): void {
    switch (frame.k) {
      case 'welcome':
        this.welcomed = true;
        this.retryMs = null;
        this.lastSaid = null;
        for (const held of this.held.values()) this.claim(held.claimant);
        this.deps.linked();
        return;
      case 'refused':
        if (frame.why === 'unknown-token') {
          // The gateway restarted and forgot this install: register again on the next dial.
          void this.deps.tokens.forget().catch((error: unknown) => {
            this.tell(`the sharing server's token could not be removed: ${errorMessage(error)}`);
          });
        }
        // A leave crossing the gateway's own drop is refused as not claimed, and means nothing.
        if (frame.why === 'not-claimed') return;
        this.tell(
          REFUSALS_THAT_CLOSE.has(frame.why)
            ? `${REFUSED[frame.why]}, and the link closed`
            : REFUSED[frame.why]
        );
        return;
      case 'challenge': {
        const held = this.held.get(peerKeyText(frame.peer));
        if (held === undefined) return;
        const sig = this.deps.sign(held.claimant.pair, claimText(held.claimant.peer, frame.nonce));
        this.send({ k: 'answer', peer: held.claimant.peer, sig });
        return;
      }
      case 'claimed': {
        const held = this.held.get(peerKeyText(frame.peer));
        if (held === undefined) return;
        held.claimed = true;
        this.sendShares(held);
        if (held.watching !== null)
          this.send({ k: 'watch', peer: held.claimant.peer, ...held.watching, on: true });
        return;
      }
      case 'unclaimed':
        this.tell(
          frame.why === 'too-many'
            ? `the sharing server holds too many characters for this client, so ${frame.peer.name} is not shared`
            : `the sharing server did not accept ${frame.peer.name}'s key`
        );
        return;
      case 'audience': {
        const held = this.held.get(peerKeyText(frame.peer));
        if (held === undefined) return;
        const was = held.listening;
        held.listening = frame.to.length > 0;
        // Nobody listened, so the gateway holds no sheet: the next one goes whole.
        if (!was) held.sent = null;
        this.push(held);
        return;
      }
      case 'unpinned':
        this.deps.unpinned(frame.peer, frame.name, frame.key);
        return;
      case 'shared':
      case 'sheet':
      case 'patch':
      case 'gone':
        this.deps.heard(frame);
        return;
      case 'controllers':
      case 'act':
        this.deps.controlled(frame);
        return;
      case 'text':
      case 'acted':
      case 'released':
        this.deps.controlling(frame);
        return;
      default: {
        const never: never = frame;
        return never;
      }
    }
  }

  private claim(claimant: Claimant): void {
    this.send({ k: 'claim', peer: claimant.peer, key: claimant.pair.publicKey });
  }

  private sendShares(held: Held): void {
    this.send({ k: 'shares', peer: held.claimant.peer, to: [...held.claimant.shares] });
  }

  /** The sheet, whole or as what changed, while somebody listens. */
  private push(held: Held): void {
    if (!held.claimed || !held.listening || held.latest === null) return;
    const { peer } = held.claimant;
    if (held.sent === null) {
      this.send({ k: 'sheet', peer, sheet: { ...held.latest } });
    } else {
      const change = sheetChange(held.sent, held.latest);
      if (change === null) return;
      this.send({ k: 'patch', peer, ...change });
    }
    held.sent = sentOf(held.latest);
    held.sentAt = this.deps.now();
  }

  private send(frame: PeerUp): void {
    this.socket?.send(JSON.stringify(frame));
  }

  private tell(message: string): void {
    if (message === this.lastSaid) return;
    this.lastSaid = message;
    this.deps.say(message);
  }
}
