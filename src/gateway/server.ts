/**
 * The gateway's HTTP face: `GET /v1/challenge` and `POST /v1/register` for an
 * install to register, and the upgrade at `/v1/stream` that becomes an
 * `InstallLink`. It sits behind Caddy on loopback, which holds the
 * certificate. Every socket is pinged each `pingEveryMs`; one that did not
 * answer the last is closed and its characters go with it.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import { acceptUpgrade, isWebSocketUpgrade } from '../node/sockets';
import {
  asPeerRegistration,
  isPeerHmac,
  PEER_BUILD_HEADER,
  PEER_PATHS,
  type ChecksSignature
} from '../shared/peerWire';
import { errorMessage } from '../shared/values';
import type { ClaimBook } from './ClaimBook';
import { InstallLink } from './InstallLink';
import type { GatewayLimits } from './limits';
import { PeerRouter } from './PeerRouter';
import { Registrar } from './Registrar';

export interface GatewayOptions {
  buildSecret: string;
  claims: ClaimBook;
  verify: ChecksSignature;
  limits: GatewayLimits;
  now(): number;
  random(bytes: number): string;
  log(line: string): void;
}

export interface Gateway {
  /** The port it listens on, once `listen` has answered. */
  listen(port: number, host: string): Promise<number>;
  /** Stop listening and close every socket. */
  close(): Promise<void>;
}

type Body = { kind: 'read'; text: string } | { kind: 'too-large' };

/** A request's body up to `most` bytes; past that the rest is not read. */
function bodyOf(request: http.IncomingMessage, most: number): Promise<Body> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > most) {
        resolve({ kind: 'too-large' });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () =>
      resolve({ kind: 'read', text: Buffer.concat(chunks).toString('utf8') })
    );
    request.on('error', reject);
  });
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  response.end(text);
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON is not a registration, answered as one that does not read.
    return null;
  }
}

export function createGateway(options: GatewayOptions): Gateway {
  const { limits } = options;
  const registrar = new Registrar(options);
  const router = new PeerRouter(limits.maxMessageBytes);
  const open = new Map<string, InstallLink>();
  const links = new Set<InstallLink>();

  const handle = async (
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> => {
    const path = (request.url ?? '/').split('?')[0];
    if (request.method === 'GET' && path === PEER_PATHS.challenge) {
      json(response, 200, registrar.challenge());
      return;
    }
    if (request.method === 'POST' && path === PEER_PATHS.register) {
      const body = await bodyOf(request, limits.maxBodyBytes);
      if (body.kind === 'too-large') {
        json(response, 413, { error: 'too large' });
        return;
      }
      const asked = asPeerRegistration(parsed(body.text));
      const build = request.headers[PEER_BUILD_HEADER];
      if (asked === null || !isPeerHmac(build)) {
        json(response, 400, { error: 'not a registration' });
        return;
      }
      const answer = registrar.register(asked, build);
      if (typeof answer === 'string') {
        options.log(`register: refused, ${answer}`);
        json(response, 403, { error: answer });
        return;
      }
      json(response, 200, answer);
      return;
    }
    json(response, 404, { error: 'not found' });
  };

  const refuse = (socket: Duplex, status: string): void => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      options.log(`${request.method ?? ''} ${request.url ?? ''} failed: ${errorMessage(error)}`);
      if (!response.headersSent) json(response, 500, { error: 'error' });
      else response.destroy();
    });
  });
  server.on('upgrade', (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    if ((request.url ?? '').split('?')[0] !== PEER_PATHS.stream || !isWebSocketUpgrade(request)) {
      refuse(socket, '404 Not Found');
      return;
    }
    const connection = acceptUpgrade(request, socket, head, {
      maxMessageBytes: limits.maxMessageBytes,
      maxBufferedBytes: limits.maxBufferedBytes,
      deflateMinBytes: limits.deflateMinBytes
    });
    // The link keeps itself in `links` while its socket is open.
    new InstallLink(connection, {
      registrar,
      claims: options.claims,
      router,
      verify: options.verify,
      limits,
      now: options.now,
      random: options.random,
      open,
      links
    });
  });

  const sweep = setInterval(() => {
    for (const link of links) link.sweep();
  }, limits.pingEveryMs);
  sweep.unref();

  return {
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve((server.address() as AddressInfo).port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(sweep);
        for (const link of links) link.end();
        server.close(() => resolve());
        server.closeAllConnections();
      })
  };
}
