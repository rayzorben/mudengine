import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { setTuning } from '../../app/tuning';
import { AccessTokens, COOKIE } from '../web/access';
import { createWebServer, loginPage, withConnectSrc, type WebServer } from '../web/server';
import type { WebSocketConnection } from '../web/sockets';

/**
 * The gate, measured rather than assumed — the lesson the noVNC image's
 * write-up recorded about "Basic auth in front of it" not meaning what it
 * sounds like. Every row here is a request and the status it gets, against
 * a real listener on loopback.
 */
const PASSWORD = 'open-sesame';
const INDEX = [
  '<!doctype html><html><head>',
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; style-src 'self' 'unsafe-inline'\" />",
  '</head><body><div id="root"></div><script type="module" src="./assets/index-abc.js"></script></body></html>'
].join('');

let dir = '';
let server: WebServer;
let port = 0;
const tokens = new AccessTokens();
const sockets: WebSocketConnection[] = [];
const log: string[] = [];

beforeAll(async () => {
  // A wrong password waits `loginDelayMs`; a test is not the place to wait a second.
  setTuning({
    ...DEFAULT_INTERNAL.tuning,
    web: { ...DEFAULT_INTERNAL.tuning.web, loginDelayMs: 1 }
  });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-web-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX);
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc.js'), 'console.log("app")');
  server = createWebServer({
    rendererDir: dir,
    password: PASSWORD,
    tokens,
    trustProxy: false,
    onSocket: (connection) => {
      sockets.push(connection);
      connection.onMessage = (text) => connection.send(`echo:${text}`);
    },
    log: (line) => log.push(line)
  });
  ({ port } = await server.listen(0, '127.0.0.1'));
});

afterAll(() => {
  setTuning(DEFAULT_INTERNAL.tuning);
  for (const socket of sockets) socket.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const base = (): string => `http://127.0.0.1:${port}`;

const get = (route: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base()}${route}`, { headers, redirect: 'manual' });

const login = (password: string): Promise<Response> =>
  fetch(`${base()}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }).toString(),
    redirect: 'manual'
  });

/** A signed-in cookie, by signing in. */
async function signIn(): Promise<string> {
  const response = await login(PASSWORD);
  expect(response.status).toBe(303);
  const cookie = response.headers.get('set-cookie') ?? '';
  const token = /mudengine_session=([0-9a-f]{64})/.exec(cookie)?.[1];
  expect(token).toBeDefined();
  return `${COOKIE}=${token}`;
}

/** The status line an upgrade attempt is answered with, by hand over TCP. */
async function upgrade(headers: string[]): Promise<{ status: string; socket: net.Socket }> {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.write(
    [
      'GET /ws HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      ...headers,
      '',
      ''
    ].join('\r\n')
  );
  const first = await new Promise<string>((resolve) =>
    socket.once('data', (chunk) => resolve(chunk.toString('latin1').split('\r\n')[0] ?? ''))
  );
  return { status: first, socket };
}

describe('without a session', () => {
  it('answers the page with the sign-in form, and a 401', async () => {
    const response = await get('/');
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    expect(body).toContain('<form method="post" action="/login">');
    expect(body).toContain('name="password"');
    expect(body).not.toContain('<script');
    expect(body).toBe(loginPage({ wrong: false, cleartext: true }));
  });

  it('serves the renderer to nobody', async () => {
    expect((await get('/assets/index-abc.js')).status).toBe(401);
    expect((await get('/index.html')).status).toBe(401);
  });

  it('answers /health to anybody, with nothing in it', async () => {
    const response = await get('/health');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('refuses the socket on the upgrade, before any channel', async () => {
    const { status, socket } = await upgrade([]);
    expect(status).toBe('HTTP/1.1 401 Unauthorized');
    socket.destroy();
    expect(log.some((line) => /refused a socket .* not signed in/.test(line))).toBe(true);
  });
});

describe('signing in', () => {
  it('refuses a wrong password with the form again and says so', async () => {
    const before = log.length;
    const response = await login('not-it');
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(loginPage({ wrong: true, cleartext: true }));
    expect(log.slice(before).some((line) => /refused a sign-in/.test(line))).toBe(true);
  });

  it('refuses an empty password', async () => {
    expect((await login('')).status).toBe(401);
  });

  it('sets a session cookie the browser will keep to itself', async () => {
    const response = await login(PASSWORD);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^mudengine_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\//);
    // Plain http: a `Secure` cookie would never be sent back and the sign-in
    // would loop for ever.
    expect(cookie).not.toContain('Secure');
  });

  it('accepts Basic credentials on any request, for a script', async () => {
    const authorization = `Basic ${Buffer.from(`anyone:${PASSWORD}`).toString('base64')}`;
    expect((await get('/', { Authorization: authorization })).status).toBe(200);
  });

  /*
   * The Basic door is a door: a guess through it is throttled and said out
   * loud exactly as one through the form is, or the form would be the only
   * route that was rate-limited and the other the one a guesser would use.
   */
  it('refuses a wrong Basic password slowly and says so, on the page and on the socket', async () => {
    const wrong = `Basic ${Buffer.from('anyone:wrong').toString('base64')}`;
    const before = log.length;
    expect((await get('/', { Authorization: wrong })).status).toBe(401);
    expect(log.slice(before).some((line) => /refused a sign-in \(Basic\)/.test(line))).toBe(true);

    const marker = log.length;
    const { status, socket } = await upgrade([`Authorization: ${wrong}`]);
    expect(status).toBe('HTTP/1.1 401 Unauthorized');
    socket.destroy();
    expect(log.slice(marker).some((line) => /refused a sign-in \(Basic\)/.test(line))).toBe(true);
  });

  /*
   * A header is something anybody can send. Without `trustProxy` the client
   * assumes cleartext whatever `X-Forwarded-Proto` says: the warning stays
   * on the page and the cookie is not marked `Secure`, which would otherwise
   * never be sent back over the plain hop the browser is actually on.
   */
  it('believes X-Forwarded-Proto only when told a proxy is in front', async () => {
    const forwarded = await fetch(`${base()}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Forwarded-Proto': 'https'
      },
      body: new URLSearchParams({ password: PASSWORD }).toString(),
      redirect: 'manual'
    });
    expect(forwarded.headers.get('set-cookie') ?? '').not.toContain('Secure');
    const page = await get('/', { 'X-Forwarded-Proto': 'https' });
    expect(await page.text()).toBe(loginPage({ wrong: false, cleartext: true }));

    const trusting = createWebServer({
      rendererDir: dir,
      password: PASSWORD,
      tokens: new AccessTokens(),
      trustProxy: true,
      onSocket: () => {},
      log: () => {}
    });
    const bound = await trusting.listen(0, '127.0.0.1');
    try {
      const signedIn = await fetch(`http://127.0.0.1:${bound.port}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Forwarded-Proto': 'https'
        },
        body: new URLSearchParams({ password: PASSWORD }).toString(),
        redirect: 'manual'
      });
      expect(signedIn.headers.get('set-cookie') ?? '').toContain('Secure');
      const quiet = await fetch(`http://127.0.0.1:${bound.port}/`, {
        headers: { 'X-Forwarded-Proto': 'https' }
      });
      expect(await quiet.text()).toBe(loginPage({ wrong: false, cleartext: false }));
    } finally {
      trusting.close();
    }
  });
});

describe('with a session', () => {
  it('serves the renderer, with connect-src stated for this host', async () => {
    const cookie = await signIn();
    const response = await get('/', { Cookie: cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain(`connect-src 'self' ws://127.0.0.1:${port} wss://127.0.0.1:${port};`);
    expect(html).toContain('id="root"');
  });

  it('serves a hashed asset as immutable, and nothing outside the renderer', async () => {
    const cookie = await signIn();
    const asset = await get('/assets/index-abc.js', { Cookie: cookie });
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect((await get('/assets/missing.js', { Cookie: cookie })).status).toBe(404);
    expect((await get('/%2e%2e/%2e%2e/etc/passwd', { Cookie: cookie })).status).toBe(404);
    expect((await get('/assets/../../../../etc/passwd', { Cookie: cookie })).status).toBe(404);
    expect((await get('/index.html.bak', { Cookie: cookie })).status).toBe(404);
  });

  it('refuses a socket opened from another origin', async () => {
    const cookie = await signIn();
    const { status, socket } = await upgrade([`Cookie: ${cookie}`, 'Origin: http://evil.example']);
    expect(status).toBe('HTTP/1.1 403 Forbidden');
    socket.destroy();
  });

  it('upgrades a socket from this origin and carries a message', async () => {
    const cookie = await signIn();
    const { status, socket } = await upgrade([
      `Cookie: ${cookie}`,
      `Origin: http://127.0.0.1:${port}`
    ]);
    expect(status).toBe('HTTP/1.1 101 Switching Protocols');
    // A masked text frame, as a client sends one, and the echo back.
    const mask = Buffer.from([1, 2, 3, 4]);
    const payload = Buffer.from('ping');
    for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ mask[i & 3]!;
    const echoed = new Promise<string>((resolve) =>
      socket.once('data', (chunk) => resolve(chunk.subarray(2).toString('utf8')))
    );
    socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | 4]), mask, payload]));
    expect(await echoed).toBe('echo:ping');
    socket.destroy();
  });

  it('refuses a socket on any other path', async () => {
    const cookie = await signIn();
    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(
      [
        'GET /elsewhere HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        `Cookie: ${cookie}`,
        '',
        ''
      ].join('\r\n')
    );
    const first = await new Promise<string>((resolve) =>
      socket.once('data', (chunk) => resolve(chunk.toString('latin1').split('\r\n')[0] ?? ''))
    );
    expect(first).toBe('HTTP/1.1 404 Not Found');
    socket.destroy();
  });
});

describe('the page and the policy', () => {
  it('states connect-src only for a host worth writing into a policy', () => {
    const html = "<meta content=\"default-src 'self'; img-src 'self'\">";
    expect(withConnectSrc(html, 'example.test:8080')).toContain(
      "connect-src 'self' ws://example.test:8080 wss://example.test:8080;"
    );
    expect(withConnectSrc(html, '[::1]:8080')).toContain('ws://[::1]:8080');
    expect(withConnectSrc(html, 'evil host; script-src *')).toBe(html);
  });

  it('draws the sign-in page without a script and says when the link is cleartext', () => {
    const page = loginPage({ wrong: true, cleartext: true });
    expect(page).not.toContain('<script');
    expect(page).toContain('<p class="note">');
    expect(page).toContain('<p class="wrong">');
    const plain = loginPage({ wrong: false, cleartext: false });
    expect(plain).not.toContain('<p class="note">');
    expect(plain).not.toContain('<p class="wrong">');
  });
});
