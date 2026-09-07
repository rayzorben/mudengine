import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';

import {
  acceptKey,
  acceptUpgrade,
  frame,
  isWebSocketUpgrade,
  OPCODE,
  WebSocketConnection
} from '../web/sockets';

/**
 * The server side of RFC 6455, proved against the client Node ships — a real
 * browser-grade `WebSocket` on the other end of a real TCP socket — and, for
 * the refusals, against raw frames written by hand, because a compliant
 * client cannot be made to send a malformed one.
 */
const GENEROUS = { maxMessageBytes: 1024 * 1024, maxBufferedBytes: 64 * 1024 * 1024 };

let server: http.Server;
let port = 0;
let accepted: WebSocketConnection[] = [];
let options = GENEROUS;

beforeEach(async () => {
  accepted = [];
  options = GENEROUS;
  server = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  server.on('upgrade', (request, socket, head) => {
    if (!isWebSocketUpgrade(request)) {
      socket.destroy();
      return;
    }
    accepted.push(acceptUpgrade(request, socket, head, options));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const connection of accepted) connection.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const open = (): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('the client could not connect'));
  });

const closed = (ws: WebSocket): Promise<{ code: number }> =>
  new Promise((resolve) => {
    ws.onclose = (event) => resolve({ code: event.code });
  });

const nextMessage = (connection: WebSocketConnection): Promise<string> =>
  new Promise((resolve) => {
    connection.onMessage = (text) => resolve(text);
  });

describe('the handshake', () => {
  it('computes the accept key the RFC gives as its example', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('recognises an upgrade and nothing else', () => {
    const request = (headers: Record<string, string>): http.IncomingMessage =>
      ({ headers }) as unknown as http.IncomingMessage;
    expect(
      isWebSocketUpgrade(
        request({
          upgrade: 'websocket',
          connection: 'keep-alive, Upgrade',
          'sec-websocket-key': 'x',
          'sec-websocket-version': '13'
        })
      )
    ).toBe(true);
    expect(isWebSocketUpgrade(request({ connection: 'Upgrade' }))).toBe(false);
    expect(
      isWebSocketUpgrade(
        request({ upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '8' })
      )
    ).toBe(false);
  });
});

describe('a compliant client', () => {
  it('sends text the server reads, and reads text the server sends', async () => {
    const ws = await open();
    const connection = accepted[0]!;
    const heard = nextMessage(connection);
    ws.send('hello from the tab');
    expect(await heard).toBe('hello from the tab');

    const replied = new Promise<string>((resolve) => {
      ws.onmessage = (event) => resolve(String(event.data));
    });
    connection.send('hello from the client');
    expect(await replied).toBe('hello from the client');
    ws.close();
  });

  it('carries a message longer than a short frame and one longer than a medium frame', async () => {
    const ws = await open();
    const connection = accepted[0]!;
    const medium = 'm'.repeat(70000);
    const heard = nextMessage(connection);
    ws.send(medium);
    expect((await heard).length).toBe(70000);

    const replied = new Promise<string>((resolve) => {
      ws.onmessage = (event) => resolve(String(event.data));
    });
    connection.send(medium);
    expect((await replied).length).toBe(70000);
    ws.close();
  });

  it('answers a ping with a pong the server hears', async () => {
    const ws = await open();
    const connection = accepted[0]!;
    const pong = new Promise<void>((resolve) => {
      connection.onPong = () => resolve();
    });
    connection.ping();
    await pong;
    ws.close();
  });

  it('closes cleanly from either side, once', async () => {
    const ws = await open();
    const connection = accepted[0]!;
    let closes = 0;
    const gone = new Promise<number>((resolve) => {
      connection.onClose = (code) => {
        closes += 1;
        resolve(code);
      };
    });
    ws.close(1000, 'done');
    expect(await gone).toBe(1000);
    expect(connection.open).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closes).toBe(1);

    const ws2 = await open();
    const connection2 = accepted[1]!;
    const event = closed(ws2);
    connection2.close(1001, 'going away');
    expect((await event).code).toBe(1001);
  });

  it('is refused a message over the cap with 1009', async () => {
    options = { ...GENEROUS, maxMessageBytes: 100 };
    const ws = await open();
    const event = closed(ws);
    ws.send('x'.repeat(200));
    expect((await event).code).toBe(1009);
  });

  it('is refused a binary frame with 1003', async () => {
    const ws = await open();
    const event = closed(ws);
    ws.send(new Uint8Array([1, 2, 3]));
    expect((await event).code).toBe(1003);
  });
});

/**
 * A raw client, for the frames a compliant one cannot be made to send. It
 * performs the handshake by hand and then writes bytes.
 */
async function rawClient(): Promise<{ socket: net.Socket; closeCode: Promise<number> }> {
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
      '',
      ''
    ].join('\r\n')
  );
  const handshake = await new Promise<string>((resolve) =>
    socket.once('data', (chunk) => resolve(chunk.toString('latin1')))
  );
  expect(handshake.startsWith('HTTP/1.1 101')).toBe(true);
  const closeCode = new Promise<number>((resolve) => {
    let seen = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      seen = Buffer.concat([seen, chunk]);
      if (seen.length >= 4 && (seen[0]! & 0x0f) === OPCODE.close) resolve(seen.readUInt16BE(2));
    });
  });
  return { socket, closeCode };
}

/** A masked client frame, which is what the protocol requires of a client. */
function masked(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i += 1) body[i] = body[i]! ^ mask[i & 3]!;
  const head = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | body.length]);
  return Buffer.concat([head, mask, body]);
}

describe('a peer that stops reading', () => {
  it('is closed with 1008 once the cap is reached, rather than buffered for', async () => {
    /*
     * A stream whose write side never drains: `_write` never calls back, so
     * every byte queues and `writableLength` climbs. Deterministic where a
     * real socket's kernel buffer is not.
     */
    const { Duplex } = await import('node:stream');
    const stalled = new Duplex({
      read() {},
      write(_chunk, _encoding, _callback) {
        // Never called back: the peer is not taking anything.
      }
    });
    const connection = new WebSocketConnection(stalled, {
      maxMessageBytes: 1024,
      maxBufferedBytes: 2048
    });
    let ended: { code: number; reason: string } | null = null;
    connection.onClose = (code, reason) => {
      ended = { code, reason };
    };
    connection.send('x'.repeat(1500));
    expect(connection.open).toBe(true);
    connection.send('x'.repeat(1500));
    connection.send('one more');
    expect(connection.open).toBe(false);
    stalled.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ended).toEqual({ code: 1008, reason: 'not reading' });
  });
});

describe('a peer that is not a browser', () => {
  it('is refused an unmasked frame with 1002', async () => {
    const { socket, closeCode } = await rawClient();
    socket.write(frame(OPCODE.text, Buffer.from('unmasked')));
    expect(await closeCode).toBe(1002);
    socket.destroy();
  });

  it('is refused a reserved bit with 1002', async () => {
    const { socket, closeCode } = await rawClient();
    const bad = masked(OPCODE.text, Buffer.from('x'));
    bad[0] = bad[0]! | 0x40;
    socket.write(bad);
    expect(await closeCode).toBe(1002);
    socket.destroy();
  });

  it('is refused invalid UTF-8 with 1007', async () => {
    const { socket, closeCode } = await rawClient();
    socket.write(masked(OPCODE.text, Buffer.from([0xff, 0xfe])));
    expect(await closeCode).toBe(1007);
    socket.destroy();
  });

  it('is refused a continuation with nothing to continue with 1002', async () => {
    const { socket, closeCode } = await rawClient();
    socket.write(masked(OPCODE.continuation, Buffer.from('tail')));
    expect(await closeCode).toBe(1002);
    socket.destroy();
  });

  it('has a fragmented message reassembled in order', async () => {
    const { socket } = await rawClient();
    const connection = accepted[0]!;
    const heard = nextMessage(connection);
    socket.write(masked(OPCODE.text, Buffer.from('one '), false));
    socket.write(masked(OPCODE.continuation, Buffer.from('two '), false));
    socket.write(masked(OPCODE.continuation, Buffer.from('three')));
    expect(await heard).toBe('one two three');
    socket.destroy();
  });

  it('has a ping answered with a pong carrying the same payload', async () => {
    const { socket } = await rawClient();
    const pong = new Promise<Buffer>((resolve) => {
      socket.on('data', (chunk) => {
        if ((chunk[0]! & 0x0f) === OPCODE.pong) resolve(chunk.subarray(2));
      });
    });
    socket.write(masked(OPCODE.ping, Buffer.from('are you there')));
    expect((await pong).toString()).toBe('are you there');
    socket.destroy();
  });
});
