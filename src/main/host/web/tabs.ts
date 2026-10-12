/**
 * The browser tabs main is serving, each kept across the sockets that carry it.
 *
 * A socket's first message is a hello (`RpcHello`). A tab that names itself
 * with its key and can be brought up to date is the same window again: it is
 * welcomed as resumed and sent what it missed (`TabLink`). Anything else is a
 * new window. A tab whose socket drops is kept for `tuning.web.resumeMs`,
 * with what main sends it held, and only then let go; so is one further
 * behind than `tuning.web.resumeBytes`, and one whose page closed.
 *
 * `WebHost` composes this: it answers the requests and owns the window
 * registry, through `TabEvents`.
 */
import type { RpcBeat, RpcInbound, RpcOutbound, RpcRequest, RpcWelcome } from '../../../shared/rpc';
import { asRpcInbound, PAGE_CLOSED } from '../../../shared/rpc';
import { tuning } from '../../app/tuning';
import { serialise } from '../serialise';
import { TabLink } from './link';
import { TabOutbox } from './outbox';
import type { WebSocketConnection } from './sockets';

/** What of a socket the tabs use. */
export type TabSocket = Pick<
  WebSocketConnection,
  'onMessage' | 'onClose' | 'onPong' | 'send' | 'close' | 'ping'
>;

export interface Tab {
  readonly id: number;
  readonly link: TabLink;
  /** What goes to this tab, and when: ready, and the repeats skipped. See `TabOutbox`. */
  readonly outbox: TabOutbox;
  /** The socket carrying it, or null while it is away. */
  connection: TabSocket | null;
  /** Answered the last ping; cleared when the next one goes out. */
  alive: boolean;
  /** Lets the tab go if it does not come back. */
  away: NodeJS.Timeout | null;
}

export interface TabEvents {
  /** A new window: register it. */
  opened(tab: Tab): void;
  /** A request, taken once however often a dropped socket made the tab send it. */
  request(tab: Tab, request: RpcRequest): void;
  /** Gone for good: drop everything kept for it. */
  ended(id: number): void;
  log(line: string): void;
}

export class TabSessions {
  private readonly tabs = new Map<number, Tab>();
  private nextId: number;
  private closing = false;

  constructor(
    firstId: number,
    private readonly events: TabEvents
  ) {
    this.nextId = firstId;
  }

  has(id: number): boolean {
    return this.tabs.has(id);
  }

  /** A socket after its handshake. It is nobody's until it says hello. */
  connect(connection: TabSocket, remote: string): void {
    let tab: Tab | null = null;
    // A socket that never says who it is would be held for nobody.
    const silent = setTimeout(() => {
      if (tab === null) connection.close(1008, 'no hello');
    }, tuning().web.helloMs);
    silent.unref?.();
    connection.onMessage = (text) => {
      const message = parse(text);
      if (message === null) {
        // Not our bridge: closed with the code that says the message was
        // refused, which the tab reads as not to send it again.
        connection.close(1007, 'malformed message');
        return;
      }
      if (message.k === 'hello') {
        clearTimeout(silent);
        if (tab !== null) connection.close(1008, 'a second hello');
        else tab = this.greet(connection, message, remote);
        return;
      }
      if (tab === null) {
        connection.close(1008, 'no hello');
        return;
      }
      if (message.k === 'ack') {
        tab.link.ack(message.n);
        return;
      }
      if (tab.link.takes(message.q)) this.events.request(tab, message);
    };
    connection.onPong = () => {
      if (tab !== null && tab.connection === connection) tab.alive = true;
    };
    connection.onClose = (code, reason) => {
      clearTimeout(silent);
      if (this.closing || tab === null || tab.connection !== connection) return;
      if (code === PAGE_CLOSED) {
        this.end(tab, 'was closed');
        return;
      }
      this.events.log(
        `web: tab ${tab.id} from ${remote} closed (${code}${reason ? ` ${reason}` : ''}); kept for it to come back.`
      );
      this.leave(tab);
    };
  }

  /** Numbers, holds and sends one message; held while the tab is away. */
  push(tab: Tab, message: RpcOutbound): void {
    if (this.tabs.get(tab.id) !== tab) return;
    const { text, error } = serialise(message, `a web message on ${message.k}`);
    if (text === null) {
      // A reply the tab is waiting on is answered with the failure.
      if (message.k === 'reply') this.push(tab, { k: 'reply', id: message.id, e: error });
      return;
    }
    if (!tab.outbox.admits(message, text)) return;
    // Numbered after the repeat test, which compares the message alone. The
    // text is a JSON object, so the number goes in as its first field.
    const framed = tab.link.hold((n) => `{"n":${n},${text.slice(1)}`);
    if (tab.link.overflowing(tuning().web.resumeBytes)) {
      this.end(tab, 'fell too far behind to be brought up to date');
      return;
    }
    // A reply the tab asked for does not count against the cap (todo 836).
    tab.connection?.send(framed, message.k === 'reply');
  }

  /**
   * Find the tabs that have gone without saying so. A tab that did not
   * answer the last ping is closed, and kept for it to come back; every other
   * one is pinged again and sent a beat the page itself can hear (`RpcBeat`).
   */
  sweep(next: number): void {
    for (const tab of this.tabs.values()) {
      const connection = tab.connection;
      if (connection === null) continue;
      if (!tab.alive) {
        connection.close(1001, 'no answer to ping');
        continue;
      }
      tab.alive = false;
      connection.ping();
      const beat: RpcBeat = { k: 'beat', next, got: tab.link.got };
      connection.send(JSON.stringify(beat));
    }
  }

  close(): void {
    this.closing = true;
    for (const tab of this.tabs.values()) {
      if (tab.away !== null) clearTimeout(tab.away);
      tab.connection?.close(1001, 'the client is shutting down');
    }
    this.tabs.clear();
  }

  private greet(
    connection: TabSocket,
    hello: Extract<RpcInbound, { k: 'hello' }>,
    remote: string
  ): Tab {
    const known = hello.tab === null ? undefined : this.tabs.get(hello.tab);
    if (known !== undefined && known.link.key === hello.key) {
      const owed = known.link.owed(hello.last);
      if (owed !== null) {
        this.rejoin(known, connection, owed);
        this.events.log(`web: tab ${known.id} came back from ${remote}, ${owed.length} owed.`);
        return known;
      }
      this.end(known, 'could not be brought up to date');
    }
    const tab: Tab = {
      id: this.nextId,
      link: new TabLink(),
      outbox: new TabOutbox(),
      connection,
      alive: true,
      away: null
    };
    this.nextId += 1;
    this.tabs.set(tab.id, tab);
    this.welcome(connection, tab, false);
    this.events.opened(tab);
    this.events.log(`web: tab ${tab.id} connected from ${remote}.`);
    return tab;
  }

  private rejoin(tab: Tab, connection: TabSocket, owed: readonly string[]): void {
    if (tab.away !== null) clearTimeout(tab.away);
    tab.away = null;
    const before = tab.connection;
    tab.connection = connection;
    tab.alive = true;
    // A socket the tab gave up on while it still looked open.
    if (before !== null && before !== connection) before.close(1000, 'replaced');
    this.welcome(connection, tab, true);
    // Sent as asked for: what a tab missed is its own, however large (todo 836).
    for (const text of owed) connection.send(text, true);
  }

  private welcome(connection: TabSocket, tab: Tab, resumed: boolean): void {
    const welcome: RpcWelcome = {
      k: 'welcome',
      tab: tab.id,
      key: tab.link.key,
      resumed,
      got: tab.link.got
    };
    connection.send(JSON.stringify(welcome), true);
  }

  private leave(tab: Tab): void {
    tab.connection = null;
    if (tab.away !== null) clearTimeout(tab.away);
    tab.away = setTimeout(() => this.end(tab, 'did not come back'), tuning().web.resumeMs);
    tab.away.unref?.();
  }

  private end(tab: Tab, why: string): void {
    if (this.tabs.get(tab.id) !== tab) return;
    this.tabs.delete(tab.id);
    if (tab.away !== null) clearTimeout(tab.away);
    tab.away = null;
    const connection = tab.connection;
    tab.connection = null;
    connection?.close(1008, why);
    this.events.ended(tab.id);
    if (!this.closing) this.events.log(`web: tab ${tab.id} let go: it ${why}.`);
  }
}

function parse(text: string): RpcInbound | null {
  try {
    return asRpcInbound(JSON.parse(text));
  } catch {
    return null;
  }
}
