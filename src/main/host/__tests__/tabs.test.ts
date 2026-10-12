import { afterEach, describe, expect, it, vi } from 'vitest';

import { TabSessions, type Tab, type TabEvents, type TabSocket } from '../web/tabs';
import { PAGE_CLOSED, type RpcRequest } from '../../../shared/rpc';

/** A socket that keeps what it was sent and can be told the tab spoke or left. */
class FakeSocket implements TabSocket {
  onMessage: ((text: string) => void) | null = null;
  onClose: ((code: number, reason: string) => void) | null = null;
  onPong: (() => void) | null = null;
  readonly sent: unknown[] = [];
  closed: { code: number; reason: string } | null = null;

  send(text: string): void {
    if (this.closed === null) this.sent.push(JSON.parse(text));
  }
  close(code = 1000, reason = ''): void {
    if (this.closed !== null) return;
    this.closed = { code, reason };
    this.onClose?.(code, reason);
  }
  ping(): void {}
  say(message: unknown): void {
    this.onMessage?.(JSON.stringify(message));
  }
  /** The socket dropped under both ends. */
  drop(): void {
    this.close(1006, '');
  }
}

function open() {
  const requests: Array<{ tab: number; request: RpcRequest }> = [];
  const opened: number[] = [];
  const ended: number[] = [];
  const windows = new Map<number, Tab>();
  const events: TabEvents = {
    opened: (tab) => {
      opened.push(tab.id);
      windows.set(tab.id, tab);
      // As the tab's clientReady does, so pushes go.
      tab.outbox.markReady();
    },
    request: (tab, request) => requests.push({ tab: tab.id, request }),
    ended: (id) => ended.push(id),
    log: () => {}
  };
  const tabs = new TabSessions(2, events);
  /** The window the tab is to main, as the registry holds it. */
  const tabOf = (id: number): Tab => {
    const tab = windows.get(id);
    if (tab === undefined) throw new Error(`no tab ${id}`);
    return tab;
  };
  return { tabs, requests, opened, ended, tabOf };
}

/** A socket that has said hello, and the tab it became. */
function join(tabs: TabSessions, hello: unknown): { socket: FakeSocket; welcome: Welcome } {
  const socket = new FakeSocket();
  tabs.connect(socket as never, 'test');
  socket.say(hello);
  return { socket, welcome: socket.sent[0] as Welcome };
}

interface Welcome {
  k: 'welcome';
  tab: number;
  key: string;
  resumed: boolean;
  got: number;
}

const FIRST = { k: 'hello', tab: null, key: null, last: 0 };

afterEach(() => {
  vi.useRealTimers();
});

describe('a browser tab kept across its sockets', () => {
  it('welcomes a first hello as a new window', () => {
    const { tabs, opened } = open();
    const { welcome } = join(tabs, FIRST);
    expect(welcome).toMatchObject({ k: 'welcome', tab: 2, resumed: false, got: 0 });
    expect(opened).toEqual([2]);
  });

  it('closes a socket that speaks before its hello', () => {
    const { tabs } = open();
    const socket = new FakeSocket();
    tabs.connect(socket as never, 'test');
    socket.say({ k: 'send', q: 1, c: 'session:input', a: [] });
    expect(socket.closed?.code).toBe(1008);
  });

  it('takes a request once, however often a drop made the tab send it', () => {
    const { tabs, requests } = open();
    const { socket } = join(tabs, FIRST);
    const input = { k: 'send', q: 1, c: 'session:input', a: ['s', 'n'] };
    socket.say(input);
    socket.say(input);
    socket.say({ ...input, q: 2 });
    expect(requests.map((entry) => entry.request.q)).toEqual([1, 2]);
  });

  it('brings a returning tab up to date as the same window', () => {
    const { tabs, opened, ended, tabOf } = open();
    const { socket, welcome } = join(tabs, FIRST);
    const tab = tabOf(welcome.tab);
    tabs.push(tab, { k: 'push', c: 'session:data', p: 'one' });
    tabs.push(tab, { k: 'push', c: 'session:data', p: 'two' });
    socket.drop();
    // Said while the tab was away, and held for it.
    tabs.push(tab, { k: 'push', c: 'session:data', p: 'three' });

    const back = join(tabs, { k: 'hello', tab: welcome.tab, key: welcome.key, last: 1 });
    expect(back.welcome).toMatchObject({ k: 'welcome', tab: welcome.tab, resumed: true });
    expect(back.socket.sent.slice(1)).toEqual([
      { n: 2, k: 'push', c: 'session:data', p: 'two' },
      { n: 3, k: 'push', c: 'session:data', p: 'three' }
    ]);
    expect(opened).toEqual([welcome.tab]);
    expect(ended).toEqual([]);
  });

  it('sends nothing again that the tab acknowledged', () => {
    const { tabs, tabOf } = open();
    const { socket, welcome } = join(tabs, FIRST);
    const tab = tabOf(welcome.tab);
    tabs.push(tab, { k: 'push', c: 'session:data', p: 'one' });
    tabs.push(tab, { k: 'push', c: 'session:data', p: 'two' });
    socket.say({ k: 'ack', n: 2 });
    socket.drop();
    const back = join(tabs, { k: 'hello', tab: welcome.tab, key: welcome.key, last: 2 });
    expect(back.socket.sent).toHaveLength(1);
  });

  it('keeps a returning tab when the socket it gave up on closes late', () => {
    const { tabs, tabOf } = open();
    const { socket, welcome } = join(tabs, FIRST);
    const tab = tabOf(welcome.tab);
    const back = join(tabs, { k: 'hello', tab: welcome.tab, key: welcome.key, last: 0 });
    expect(socket.closed?.reason).toBe('replaced');
    tabs.push(tab, { k: 'push', c: 'session:data', p: 'after' });
    expect(back.socket.sent.at(-1)).toMatchObject({ n: 1, p: 'after' });
  });

  it('makes a new window of a hello with the wrong key', () => {
    const { tabs, opened } = open();
    const { socket, welcome } = join(tabs, FIRST);
    socket.drop();
    const stranger = join(tabs, { k: 'hello', tab: welcome.tab, key: 'guessed', last: 0 });
    expect(stranger.welcome).toMatchObject({ resumed: false });
    expect(stranger.welcome.tab).not.toBe(welcome.tab);
    expect(opened).toHaveLength(2);
  });

  it('lets a tab go that does not come back in time', () => {
    vi.useFakeTimers();
    const { tabs, ended } = open();
    const { socket, welcome } = join(tabs, FIRST);
    socket.drop();
    vi.advanceTimersByTime(14_399_000);
    expect(ended).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(ended).toEqual([welcome.tab]);
    expect(tabs.has(welcome.tab)).toBe(false);
  });

  it('makes a new window of a tab it can no longer bring up to date', () => {
    const { tabs, ended } = open();
    const { socket, welcome } = join(tabs, FIRST);
    socket.drop();
    // The tab claims more than was ever sent to it.
    const back = join(tabs, { k: 'hello', tab: welcome.tab, key: welcome.key, last: 9 });
    expect(back.welcome).toMatchObject({ resumed: false });
    expect(ended).toEqual([welcome.tab]);
  });

  it('lets a tab go that fell further behind than it can be held for', () => {
    const { tabs, ended, tabOf } = open();
    const { socket, welcome } = join(tabs, FIRST);
    socket.drop();
    const half = 'x'.repeat(17_000_000);
    tabs.push(tabOf(welcome.tab), { k: 'push', c: 'session:data', p: half });
    expect(ended).toEqual([]);
    tabs.push(tabOf(welcome.tab), { k: 'push', c: 'session:data', p: half });
    expect(ended).toEqual([welcome.tab]);
  });

  it('lets a tab go at once when its page closed', () => {
    const { tabs, ended } = open();
    const { socket, welcome } = join(tabs, FIRST);
    socket.close(PAGE_CLOSED, '');
    expect(ended).toEqual([welcome.tab]);
  });

  it('closes a socket that never says hello', () => {
    vi.useFakeTimers();
    const { tabs } = open();
    const socket = new FakeSocket();
    tabs.connect(socket as never, 'test');
    vi.advanceTimersByTime(9_000);
    expect(socket.closed).toBeNull();
    vi.advanceTimersByTime(2_000);
    expect(socket.closed).toEqual({ code: 1008, reason: 'no hello' });
  });

  it('lets a connected tab go that is not taking what it is sent', () => {
    const { tabs, ended, tabOf } = open();
    const { socket, welcome } = join(tabs, FIRST);
    const half = 'x'.repeat(17_000_000);
    tabs.push(tabOf(welcome.tab), { k: 'push', c: 'session:data', p: half });
    tabs.push(tabOf(welcome.tab), { k: 'push', c: 'session:data', p: half });
    expect(ended).toEqual([welcome.tab]);
    expect(socket.closed?.code).toBe(1008);
  });
});
