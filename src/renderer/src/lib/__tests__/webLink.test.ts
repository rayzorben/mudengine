import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RpcOutbound } from '@shared/rpc';

import { openWebLink, type WebLink } from '../webLink';

/** A browser WebSocket the test drives from the client's side. */
class FakeWebSocket {
  static readonly OPEN = 1;
  static made: FakeWebSocket[] = [];
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.made.push(this);
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close(): void {}
  /** The socket opened: the tab says hello. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  hear(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  /** The client closed it, or the network did. */
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const latest = (): FakeWebSocket => FakeWebSocket.made.at(-1)!;

const element = () => ({
  id: '',
  className: '',
  textContent: '',
  setAttribute: () => {},
  replaceChildren: () => {},
  appendChild: () => {},
  remove: () => {}
});

let frames: RpcOutbound[];
let renewed: number;
let link: WebLink;
let abort: AbortController;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.made = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('location', { protocol: 'https:', host: 'mud.example' });
  vi.stubGlobal('window', { addEventListener: () => {} });
  vi.stubGlobal('document', {
    addEventListener: () => {},
    getElementById: () => null,
    createElement: element,
    body: { appendChild: () => {} },
    visibilityState: 'visible'
  });
  vi.stubGlobal('fetch', () => new Promise(() => {}));
  frames = [];
  renewed = 0;
  abort = new AbortController();
  link = openWebLink(
    {
      frame: (message) => frames.push(message),
      renewed: () => {
        renewed += 1;
      }
    },
    abort.signal
  );
});

afterEach(() => {
  abort.abort();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const WELCOME = { k: 'welcome', tab: 2, key: 'secret', resumed: false, got: 0 };
const kinds = (socket: FakeWebSocket) => socket.sent.map((message) => message['k']);

describe('a browser tab’s link', () => {
  it('says hello first, then sends what was asked before the welcome', () => {
    link.send({ k: 'send', c: 'app:client-ready', a: [] });
    const socket = latest();
    socket.open();
    expect(socket.sent).toEqual([{ k: 'hello', tab: null, key: null, last: 0 }]);
    socket.hear(WELCOME);
    expect(socket.sent[1]).toMatchObject({ k: 'send', q: 1, c: 'app:client-ready' });
  });

  it('takes each message once', () => {
    const socket = latest();
    socket.open();
    socket.hear(WELCOME);
    socket.hear({ k: 'push', n: 1, c: 'session:data', p: 'one' });
    socket.hear({ k: 'push', n: 1, c: 'session:data', p: 'one' });
    socket.hear({ k: 'push', n: 2, c: 'session:data', p: 'two' });
    expect(frames).toEqual([
      { k: 'push', c: 'session:data', p: 'one' },
      { k: 'push', c: 'session:data', p: 'two' }
    ]);
  });

  it('comes back as the same tab and sends again what the client had not taken', () => {
    const first = latest();
    first.open();
    first.hear(WELCOME);
    first.hear({ k: 'push', n: 1, c: 'session:data', p: 'one' });
    link.send({ k: 'invoke', id: 1, c: 'sessions:list', a: [] });
    first.drop();

    const second = latest();
    expect(second).not.toBe(first);
    second.open();
    expect(second.sent[0]).toEqual({ k: 'hello', tab: 2, key: 'secret', last: 1 });
    second.hear({ ...WELCOME, resumed: true, got: 0 });
    expect(second.sent[1]).toMatchObject({ k: 'invoke', q: 1, c: 'sessions:list' });
    expect(renewed).toBe(0);
  });

  it('drops a key gone stale while the link was down, and keeps everything else', () => {
    const first = latest();
    first.open();
    first.hear(WELCOME);
    first.drop();
    link.send({ k: 'send', c: 'session:input', a: ['s', 'n'] }, true);
    link.send({ k: 'invoke', id: 1, c: 'sessions:list', a: [] });
    vi.advanceTimersByTime(5_000);
    link.send({ k: 'send', c: 'session:input', a: ['s', 'e'] }, true);

    const second = latest();
    second.open();
    second.hear({ ...WELCOME, resumed: true });
    expect(second.sent.slice(1).map((message) => message['c'] + ':' + message['q'])).toEqual([
      'sessions:list:2',
      'session:input:3'
    ]);
  });

  it('does not send again the request the client refused', () => {
    const first = latest();
    first.open();
    first.hear(WELCOME);
    link.send({ k: 'invoke', id: 1, c: 'session:ask', a: ['x'.repeat(10)] });
    link.send({ k: 'invoke', id: 2, c: 'sessions:list', a: [] });
    first.drop(1009);

    const second = latest();
    second.open();
    second.hear({ ...WELCOME, resumed: true, got: 0 });
    expect(second.sent.slice(1).map((message) => message['q'])).toEqual([2]);
  });

  it('starts the window over when the client no longer knows the tab', () => {
    const first = latest();
    first.open();
    first.hear(WELCOME);
    first.hear({ k: 'push', n: 1, c: 'session:data', p: 'one' });
    link.send({ k: 'invoke', id: 1, c: 'sessions:list', a: [] });
    first.drop();

    const second = latest();
    second.open();
    second.hear({ ...WELCOME, tab: 3, resumed: false });
    expect(renewed).toBe(1);
    expect(kinds(second)).toEqual(['hello']);
    // Numbered afresh: the new window's first message is taken.
    second.hear({ k: 'push', n: 1, c: 'session:data', p: 'new' });
    expect(frames.at(-1)).toEqual({ k: 'push', c: 'session:data', p: 'new' });
  });

  it('covers the window only once the link has been down a while', () => {
    const first = latest();
    first.open();
    first.hear(WELCOME);
    first.drop();
    expect(link.covered).toBe(false);
    vi.advanceTimersByTime(1_600);
    expect(link.covered).toBe(true);
    const second = latest();
    second.open();
    second.hear({ ...WELCOME, resumed: true });
    expect(link.covered).toBe(false);
  });

  it('gives up a socket that has heard nothing for two beats', () => {
    const first = latest();
    first.open();
    first.hear(WELCOME);
    first.hear({ k: 'beat', next: 10_000, got: 0 });
    vi.advanceTimersByTime(19_000);
    expect(FakeWebSocket.made).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.made).toHaveLength(2);
  });
});
