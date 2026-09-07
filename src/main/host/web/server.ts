/**
 * The HTTP side of web mode: the sign-in page, the built renderer, and the
 * upgrade to the socket that carries `IpcApi`.
 *
 * **Everything is behind the password except the sign-in itself and
 * `/health`.** The renderer is open-source JavaScript and serving it to a
 * stranger leaks nothing, but the line is drawn where it is easy to see: a
 * request without a session gets the sign-in page and a request with one
 * gets the client. The one exception — `/health`, which answers `ok` and
 * nothing else — exists so a container's health check can ask without a
 * password in its command line.
 *
 * **The socket is gated on the upgrade, before any channel is served**, and
 * on the `Origin` as well as the cookie: a browser sends the cookie on a
 * cross-site WebSocket handshake, so a page somewhere else could otherwise
 * open the client's socket in a signed-in browser. An origin that is not
 * this host is refused; a request with no origin at all (a script, a probe)
 * is judged on its credentials alone.
 *
 * **The renderer's CSP is rewritten on the way out.** `src/renderer/index.html`
 * says `default-src 'self'` with no `connect-src`, and whether `'self'`
 * covers a same-origin `ws://` upgrade differs by CSP level and browser (the
 * todo that produced this said: verify, do not assume). So the served copy
 * states `connect-src` for exactly this host, and `npm run smoke:web` loads
 * it in a real Chromium and proves the socket opens under it.
 *
 * Cleartext, and said so: the password travels as a form field and the
 * session as a cookie, and neither is protected on a plain `http://` hop. The
 * sign-in page says it every time it is drawn over one, and the `Secure`
 * flag goes on the cookie only when the request actually came over TLS.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';

import { RPC_PATH } from '../../../shared/rpc';
import { t } from '../../app/i18n';
import { isWithin } from '../../app/browse';
import { tuning } from '../../app/tuning';
import { AccessTokens, basicPassword, COOKIE, cookieToken, passwordMatches } from './access';
import { acceptUpgrade, isWebSocketUpgrade, type WebSocketConnection } from './sockets';

export interface WebServerOptions {
  /** `out/renderer`: the built window. */
  rendererDir: string;
  password: string;
  tokens: AccessTokens;
  /** Whether `X-Forwarded-Proto` from a proxy in front is believed. */
  trustProxy: boolean;
  /** A signed-in tab has opened the socket. */
  onSocket(connection: WebSocketConnection, remote: string): void;
  /** The server explaining itself: a refused sign-in, a refused upgrade. */
  log(line: string): void;
}

export interface WebServer {
  listen(port: number, host: string): Promise<{ port: number; host: string }>;
  close(): void;
}

/** What the server will hand out by extension, and nothing else. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
};

/** The marker the renderer's CSP carries, and what it becomes for one host. */
const CSP_MARKER = "default-src 'self';";

/** A `Host` header worth writing into a policy: a name or address, and a port. */
const HOST_HEADER = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** The longest sign-in body accepted. A password is not a kilobyte. */
const LOGIN_BODY_LIMIT = 4096;

/** What every response carries, so a browser cannot be talked into guessing. */
const HARDENING: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer'
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The sign-in page.
 *
 * Self-contained on purpose: it is served to somebody who has not signed in,
 * so it links to nothing that is gated, and it carries its own few lines of
 * style rather than the renderer's stylesheet. The words are the dictionary's
 * like every other string the client shows.
 */
export function loginPage(options: { wrong: boolean; cleartext: boolean }): string {
  const lines = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(t('web.login.title'))}</title>`,
    '<style>',
    'html{color-scheme:dark;background:#1a1d24;color:#d6d9e0;font:15px/1.5 system-ui,sans-serif}',
    'body{margin:0;min-height:100vh;display:grid;place-items:center}',
    'main{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:28px 32px;width:min(380px,90vw);box-shadow:0 18px 40px rgba(0,0,0,0.35)}',
    'h1{font-size:20px;margin:0 0 6px;font-weight:600}',
    'p{margin:0 0 14px;color:#a8adb8}',
    'label{display:block;margin:0 0 12px}',
    'span{display:block;font-size:13px;margin-bottom:4px;color:#a8adb8}',
    'input{width:100%;box-sizing:border-box;font:inherit;padding:9px 11px;border-radius:8px;border:1px solid rgba(255,255,255,0.14);background:rgba(0,0,0,0.25);color:inherit}',
    'button{font:inherit;padding:9px 16px;border-radius:8px;border:0;background:#4f8fa8;color:#0f1216;cursor:pointer}',
    '.wrong{color:#e9a2a2}',
    '.note{font-size:13px;color:#c9a35a;margin-top:16px}',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeHtml(t('web.login.heading'))}</h1>`,
    `<p>${escapeHtml(t('web.login.lead'))}</p>`,
    '<form method="post" action="/login">',
    `<label><span>${escapeHtml(t('web.login.passwordLabel'))}</span>`,
    '<input autocomplete="current-password" autofocus name="password" type="password"></label>',
    options.wrong ? `<p class="wrong">${escapeHtml(t('web.login.wrong'))}</p>` : '',
    `<button type="submit">${escapeHtml(t('web.login.submit'))}</button>`,
    '</form>',
    options.cleartext ? `<p class="note">${escapeHtml(t('web.login.cleartext'))}</p>` : '',
    '</main>',
    '</body>',
    '</html>'
  ];
  return lines.filter((line) => line.length > 0).join('\n');
}

/** The renderer's page with `connect-src` stated for the host it was asked from. */
export function withConnectSrc(html: string, host: string): string {
  if (!HOST_HEADER.test(host)) return html;
  return html.replace(
    CSP_MARKER,
    `default-src 'self'; connect-src 'self' ws://${host} wss://${host};`
  );
}

export function createWebServer(options: WebServerOptions): WebServer {
  const rendererDir = path.resolve(options.rendererDir);
  let indexHtml: string | null = null;
  let saidNoMarker = false;

  const index = (): string => {
    indexHtml ??= fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
    if (!indexHtml.includes(CSP_MARKER) && !saidNoMarker) {
      saidNoMarker = true;
      options.log(
        "web: the renderer's index.html carries no CSP marker to state connect-src in, so the socket relies on 'self'."
      );
    }
    return indexHtml;
  };

  /*
   * Whether the browser's hop is TLS. The socket knows; a header only claims.
   * `X-Forwarded-Proto` is believed only when whoever runs the client has
   * said a proxy of theirs is in front (`trustProxy`), because it arrives in
   * the request and a hop that is not TLS to the browser could otherwise
   * suppress the cleartext warning and mark the cookie `Secure`.
   */
  const encrypted = (request: http.IncomingMessage): boolean =>
    Boolean((request.socket as { encrypted?: boolean }).encrypted) ||
    (options.trustProxy &&
      String(request.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https');

  /**
   * What a request carries: a session, the password as Basic, the *wrong*
   * password as Basic, or nothing. The third is its own answer because it is
   * a guess, and a guess is throttled and said out loud whichever door it
   * came through — the form is not the only one.
   */
  type Credentials = 'session' | 'basic' | 'wrong-basic' | 'none';
  const credentialsOf = (request: http.IncomingMessage): Credentials => {
    if (options.tokens.has(cookieToken(request.headers['cookie']))) return 'session';
    const basic = basicPassword(request.headers['authorization']);
    if (basic === null) return 'none';
    return passwordMatches(basic, options.password) ? 'basic' : 'wrong-basic';
  };

  const remoteOf = (request: http.IncomingMessage): string =>
    `${request.socket.remoteAddress ?? '?'}:${request.socket.remotePort ?? '?'}`;

  /*
   * A wrong password, said out loud and answered slowly. The delay is the
   * whole of the rate limit — a guess a second — and it is imposed on the
   * wrong answer only, so somebody who mistyped once pays it once.
   */
  const refusedSignIn = async (request: http.IncomingMessage, how: string): Promise<void> => {
    options.log(`web: refused a sign-in (${how}) from ${remoteOf(request)}.`);
    await new Promise((resolve) => setTimeout(resolve, tuning().web.loginDelayMs));
  };

  const reply = (
    response: http.ServerResponse,
    status: number,
    headers: Record<string, string>,
    body: string | Buffer | null
  ): void => {
    response.writeHead(status, { ...HARDENING, ...headers });
    response.end(body ?? undefined);
  };

  const page = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    status: number,
    wrong: boolean,
    headers: Record<string, string> = {}
  ): void => {
    reply(
      response,
      status,
      {
        ...headers,
        'Content-Type': CONTENT_TYPES['.html']!,
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'"
      },
      request.method === 'HEAD' ? null : loginPage({ wrong, cleartext: !encrypted(request) })
    );
  };

  const readBody = (request: http.IncomingMessage): Promise<string | null> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > LOGIN_BODY_LIMIT) {
          resolve(null);
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', () => resolve(null));
    });

  const login = async (
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> => {
    if (request.method !== 'POST') {
      reply(response, 405, { Allow: 'POST', 'Content-Type': CONTENT_TYPES['.txt']! }, 'POST');
      return;
    }
    const body = await readBody(request);
    const given = body === null ? '' : (new URLSearchParams(body).get('password') ?? '');
    if (given.length > 0 && passwordMatches(given, options.password)) {
      const token = options.tokens.issue();
      const cookie = [
        `${COOKIE}=${token}`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        ...(encrypted(request) ? ['Secure'] : [])
      ].join('; ');
      reply(
        response,
        303,
        { Location: '/', 'Set-Cookie': cookie, 'Cache-Control': 'no-store' },
        null
      );
      return;
    }
    await refusedSignIn(request, 'form');
    page(request, response, 401, true);
  };

  const serveStatic = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    pathname: string
  ): void => {
    const wanted = pathname === '/' ? '/index.html' : pathname;
    const file = path.resolve(rendererDir, `.${wanted}`);
    if (!isWithin(rendererDir, file)) {
      reply(response, 404, { 'Content-Type': CONTENT_TYPES['.txt']! }, 'not found');
      return;
    }
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()];
    if (type === undefined) {
      reply(response, 404, { 'Content-Type': CONTENT_TYPES['.txt']! }, 'not found');
      return;
    }

    if (wanted === '/index.html') {
      let html: string;
      try {
        html = withConnectSrc(index(), String(request.headers['host'] ?? ''));
      } catch (error) {
        options.log(`web: the renderer is not built: ${String(error)}`);
        reply(
          response,
          500,
          { 'Content-Type': CONTENT_TYPES['.txt']! },
          'the renderer is not built'
        );
        return;
      }
      reply(
        response,
        200,
        { 'Content-Type': type, 'Cache-Control': 'no-store' },
        request.method === 'HEAD' ? null : html
      );
      return;
    }

    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) {
        reply(response, 404, { 'Content-Type': CONTENT_TYPES['.txt']! }, 'not found');
        return;
      }
      // Vite names every asset by its content hash, so a cached one can never
      // be stale; anything else is re-asked for on each load.
      const cache = wanted.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache';
      response.writeHead(200, {
        ...HARDENING,
        'Content-Type': type,
        'Content-Length': String(stat.size),
        'Cache-Control': cache
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      const stream = fs.createReadStream(file);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
    });
  };

  const handle = async (
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      reply(response, 400, { 'Content-Type': CONTENT_TYPES['.txt']! }, 'bad request');
      return;
    }

    if (pathname === '/health') {
      reply(
        response,
        200,
        { 'Content-Type': CONTENT_TYPES['.txt']!, 'Cache-Control': 'no-store' },
        'ok'
      );
      return;
    }
    if (pathname === '/login') {
      await login(request, response);
      return;
    }
    const credentials = credentialsOf(request);
    if (credentials === 'wrong-basic') await refusedSignIn(request, 'Basic');
    if (credentials === 'wrong-basic' || credentials === 'none') {
      page(request, response, 401, false);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      reply(response, 405, { Allow: 'GET, HEAD', 'Content-Type': CONTENT_TYPES['.txt']! }, 'GET');
      return;
    }
    serveStatic(request, response, pathname);
  };

  /** A refused upgrade: one status line, and the socket goes. */
  const refuse = (socket: Duplex, status: string): void => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  const upgrade = async (
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> => {
    let pathname = '';
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      // Refused below, as a path that is not the socket's.
    }
    if (pathname !== RPC_PATH || !isWebSocketUpgrade(request)) {
      refuse(socket, '404 Not Found');
      return;
    }
    const credentials = credentialsOf(request);
    if (credentials === 'wrong-basic' || credentials === 'none') {
      options.log(`web: refused a socket from ${remoteOf(request)}: not signed in.`);
      if (credentials === 'wrong-basic') await refusedSignIn(request, 'Basic');
      refuse(socket, '401 Unauthorized');
      return;
    }
    const origin = request.headers['origin'];
    if (typeof origin === 'string') {
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch {
        // An origin that is not a URL is not this host.
      }
      if (originHost !== String(request.headers['host'] ?? '')) {
        options.log(
          `web: refused a socket from ${remoteOf(request)}: origin ${origin} is not this host.`
        );
        refuse(socket, '403 Forbidden');
        return;
      }
    }
    const connection = acceptUpgrade(request, socket, head, {
      maxMessageBytes: tuning().web.maxMessageBytes,
      maxBufferedBytes: tuning().web.maxBufferedBytes
    });
    options.onSocket(connection, remoteOf(request));
  };

  /*
   * Neither handler may reject into `unhandledRejection`: in web mode there
   * is no window for the guard to report through, and an aborted request
   * body is an ordinary thing a client does.
   */
  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      options.log(`web: ${request.method ?? ''} ${request.url ?? ''} failed: ${String(error)}`);
      if (!response.headersSent) {
        reply(response, 500, { 'Content-Type': CONTENT_TYPES['.txt']! }, 'error');
      } else {
        response.destroy();
      }
    });
  });
  server.on('upgrade', (request, socket, head) => {
    upgrade(request, socket, head).catch((error: unknown) => {
      options.log(`web: upgrade from ${remoteOf(request)} failed: ${String(error)}`);
      socket.destroy();
    });
  });

  return {
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        const failed = (error: NodeJS.ErrnoException): void => {
          server.off('listening', listening);
          reject(
            error.code === 'EADDRINUSE'
              ? new Error(`${host}:${port} is already in use — is another client serving there?`)
              : error
          );
        };
        const listening = (): void => {
          server.off('error', failed);
          const address = server.address();
          const bound = typeof address === 'object' && address !== null ? address.port : port;
          resolve({ port: bound, host });
        };
        server.once('error', failed);
        server.once('listening', listening);
        server.listen(port, host);
      }),
    close: () => {
      server.close();
      // Idle keep-alive connections would otherwise hold the process open
      // past the sockets it has already said goodbye on.
      server.closeAllConnections();
    }
  };
}
