/**
 * One install's socket: the signed hello first, then each character claimed
 * by answering a challenge with its key, then its share lists and sheets
 * handed to the router. Every frame is counted against the install's byte
 * budget and read through `asPeerUp`; a refusal in `REFUSALS_THAT_CLOSE`
 * ends the socket, any other is said and the socket stays.
 */
import type { WebSocketConnection } from '../node/sockets';
import { peerKeyText, type PeerKey } from '../shared/peers';
import {
  asPeerUp,
  claimText,
  REFUSALS_THAT_CLOSE,
  type ChecksSignature,
  type PeerDown,
  type PeerUp,
  type RefusedWhy
} from '../shared/peerWire';
import { ByteBudget } from './ByteBudget';
import type { ClaimBook } from './ClaimBook';
import type { GatewayLimits } from './limits';
import type { InstallLine, PeerRouter } from './PeerRouter';
import type { Registrar } from './Registrar';

/** The socket as the link drives it. */
export type InstallSocket = Pick<
  WebSocketConnection,
  'send' | 'close' | 'ping' | 'onMessage' | 'onClose' | 'onPong'
>;

export interface InstallLinkDeps {
  registrar: Registrar;
  claims: ClaimBook;
  router: PeerRouter;
  verify: ChecksSignature;
  limits: GatewayLimits;
  now(): number;
  random(bytes: number): string;
  /** The open link of each install, so a second socket with the same token replaces the first. */
  open: Map<string, InstallLink>;
  /** Every link with its socket open, hello or not, for the ping sweep. */
  links: Set<InstallLink>;
}

interface Pending {
  readonly peer: PeerKey;
  readonly key: string;
  readonly nonce: string;
}

export class InstallLink implements InstallLine {
  private token: string | null = null;
  private readonly budget: ByteBudget;
  /** Challenges sent and not yet answered, by `peerKeyText`. */
  private readonly pending = new Map<string, Pending>();
  /** Answered the last ping. */
  answered = true;

  constructor(
    private readonly socket: InstallSocket,
    private readonly deps: InstallLinkDeps
  ) {
    this.budget = new ByteBudget(deps.limits.bytesPerSecond, deps.limits.burstBytes, deps.now());
    socket.onMessage = (text) => this.heard(text);
    socket.onPong = () => {
      this.answered = true;
    };
    socket.onClose = () => this.closed();
    deps.links.add(this);
  }

  send(frame: PeerDown): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** Close the socket, saying why first. */
  refuse(why: RefusedWhy): void {
    this.send({ k: 'refused', why });
    if (REFUSALS_THAT_CLOSE.has(why)) this.socket.close(1008, why);
  }

  /** The gateway is stopping. */
  end(): void {
    this.socket.close(1001, 'gateway stopping');
  }

  /** Ping, or close a socket that did not answer the last one. */
  sweep(): void {
    if (!this.answered) {
      this.socket.close(1001, 'no answer to ping');
      return;
    }
    this.answered = false;
    this.socket.ping();
  }

  private heard(text: string): void {
    if (!this.budget.take(Buffer.byteLength(text, 'utf8'), this.deps.now())) {
      return this.refuse('over-limit');
    }
    let frame: PeerUp | null;
    try {
      frame = asPeerUp(JSON.parse(text));
    } catch {
      // Not JSON: an install off the wire, refused below like any frame that does not read.
      frame = null;
    }
    if (frame === null) return this.refuse('malformed');
    if (this.token === null) {
      if (frame.k !== 'hello') return this.refuse('malformed');
      return this.hello(frame);
    }
    const why = this.act(frame);
    if (why !== null) this.refuse(why);
  }

  private hello(frame: Extract<PeerUp, { k: 'hello' }>): void {
    const check = this.deps.registrar.hello(frame);
    if (check !== 'ok') return this.refuse(check);
    this.token = frame.token;
    this.deps.open.get(frame.token)?.refuse('replaced');
    this.deps.open.set(frame.token, this);
    this.send({ k: 'welcome' });
  }

  private act(frame: PeerUp): RefusedWhy | null {
    const { router } = this.deps;
    switch (frame.k) {
      case 'hello':
        return 'malformed';
      case 'claim':
        return this.challenge(frame.peer, frame.key);
      case 'answer':
        return this.answer(frame.peer, frame.sig);
      case 'shares':
        return router.setShares(this, frame.peer, frame.to);
      case 'sheet':
        return router.sheet(this, frame.peer, frame.sheet);
      case 'patch':
        return router.patch(this, frame.peer, frame);
      case 'leave':
        this.pending.delete(peerKeyText(frame.peer));
        return router.leave(this, frame.peer);
      default: {
        const never: never = frame;
        return never;
      }
    }
  }

  private challenge(peer: PeerKey, key: string): null {
    const id = peerKeyText(peer);
    const held = this.deps.router.heldBy(this) + this.pending.size;
    if (!this.pending.has(id) && held >= this.deps.limits.mostClaims) {
      this.send({ k: 'unclaimed', peer, why: 'too-many' });
      return null;
    }
    const nonce = this.deps.random(32);
    this.pending.set(id, { peer, key, nonce });
    this.send({ k: 'challenge', peer, nonce });
    return null;
  }

  private answer(peer: PeerKey, sig: string): RefusedWhy | null {
    const id = peerKeyText(peer);
    const pending = this.pending.get(id);
    if (pending === undefined) return 'not-claimed';
    this.pending.delete(id);
    if (!this.deps.verify(pending.key, claimText(pending.peer, pending.nonce), sig)) {
      this.send({ k: 'unclaimed', peer, why: 'answer' });
      return null;
    }
    const answer = this.deps.claims.claim(pending.peer, pending.key);
    if (answer === 'held' || answer === 'full') {
      this.send({ k: 'unclaimed', peer, why: answer });
      return null;
    }
    // Said before the router tells it who listens or what is shared with it.
    this.send({ k: 'claimed', peer: pending.peer });
    this.deps.router.claim(this, pending.peer, pending.key);
    return null;
  }

  private closed(): void {
    this.deps.links.delete(this);
    this.deps.router.dropLine(this);
    if (this.token !== null && this.deps.open.get(this.token) === this) {
      this.deps.open.delete(this.token);
    }
  }
}
