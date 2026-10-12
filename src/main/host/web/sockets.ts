/**
 * The server side of a WebSocket, RFC 6455, in the two hundred lines it takes.
 *
 * Written rather than depended on, for the reason `yaml` and `mdb-reader` are
 * bundled: the main chunk externalises its dependencies, so a package here is
 * a `node_modules` the container has to carry and a resolution Electron's ESM
 * loader has to get right, for a protocol whose server half is a handshake,
 * a frame header and a masking XOR. Text frames only — the wire is JSON
 * (`src/shared/rpc.ts`) — and a peer that sends anything else is closed with
 * the code that says why, never accommodated.
 *
 * What is refused, and with which close code, because each is a peer that is
 * not our bridge: an unmasked client frame (1002, the protocol says a client
 * masks), a reserved bit (1002), a control frame fragmented or over 125
 * bytes (1002), a binary frame (1003), invalid UTF-8 (1007), and a message
 * larger than the cap (1009). The cap is `tuning.web.maxMessageBytes` and is
 * checked on the *declared* length before a byte of payload is held.
 *
 * `permessage-deflate` (RFC 7692) when the browser offers it, each message
 * on its own (no context takeover either way): the browser inflates in its
 * network layer, off the page's thread, and nothing is kept per socket. A
 * compressed message is inflated under the same cap.
 */
import { createHash } from 'node:crypto';
import { constants as zlib, deflateRawSync, inflateRawSync } from 'node:zlib';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/** The constant the handshake mixes into the key. It is what the RFC says it is. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa
} as const;

/** What a deflated message ends with before the sender strips it (RFC 7692 §7.2.1). */
const DEFLATE_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);
/** The bit a compressed message's first frame carries. */
const RSV1 = 0x40;

/** The extension this server agrees to: each message deflated on its own. */
const DEFLATE_RESPONSE =
  'permessage-deflate; server_no_context_takeover; client_no_context_takeover';

/** Whether the browser offered `permessage-deflate`. */
export function offersDeflate(request: IncomingMessage): boolean {
  return String(request.headers['sec-websocket-extensions'] ?? '')
    .split(',')
    .some((offer) => offer.split(';')[0]!.trim().toLowerCase() === 'permessage-deflate');
}

/** `Sec-WebSocket-Accept` for a client's `Sec-WebSocket-Key`. */
export function acceptKey(key: string): string {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64');
}

/** Whether a request is a WebSocket upgrade this server understands. */
export function isWebSocketUpgrade(request: IncomingMessage): boolean {
  const upgrade = String(request.headers['upgrade'] ?? '').toLowerCase();
  const connection = String(request.headers['connection'] ?? '').toLowerCase();
  const key = request.headers['sec-websocket-key'];
  const version = request.headers['sec-websocket-version'];
  return (
    upgrade === 'websocket' &&
    connection.split(',').some((token) => token.trim() === 'upgrade') &&
    typeof key === 'string' &&
    key.length > 0 &&
    version === '13'
  );
}

/**
 * One frame, server to client: never masked, which is what the RFC says of
 * a server. Exported for the tests, which are the other side of the wire.
 */
export function frame(opcode: number, payload: Buffer, compressed = false): Buffer {
  const length = payload.length;
  const first = 0x80 | (compressed ? RSV1 : 0) | opcode;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([first, length]);
  } else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

export interface ConnectionOptions {
  /** The largest message accepted, declared length included. */
  maxMessageBytes: number;
  /**
   * How much may be queued for a peer that is not reading before it is
   * closed. The game stream arrives at stream rate whether or not a tab
   * takes it, and a tab that has stalled would otherwise hold it all in
   * main's heap until the ping sweep noticed.
   */
  maxBufferedBytes: number;
  /** Messages shorter than this go uncompressed: a beat or an ack gains nothing. */
  deflateMinBytes: number;
}

/**
 * A live socket after the handshake.
 *
 * Callbacks rather than an emitter: there are three things a peer can do and
 * one thing it can stop doing, and a field per event is the whole of the
 * interface. `onClose` fires exactly once, however the socket ended.
 */
export class WebSocketConnection {
  onMessage: ((text: string) => void) | null = null;
  onClose: ((code: number, reason: string) => void) | null = null;
  onPong: (() => void) | null = null;

  private buffer: Buffer = Buffer.alloc(0);
  /** A message being reassembled from fragments, or null between messages. */
  private fragments: Buffer[] | null = null;
  private fragmentBytes = 0;
  /** The message being reassembled was sent compressed. */
  private fragmentsDeflated = false;
  private closeSent = false;
  private closed = false;
  /** What this side said on the way out, so the end is reported as it was meant. */
  private saidGoodbye: { code: number; reason: string } | null = null;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  /**
   * Bytes of a reply the tab asked for still queued on the socket, each frame
   * taken off in its own write's callback; the cap counts what is beyond them.
   */
  private requested = 0;

  constructor(
    private readonly socket: Duplex,
    private readonly options: ConnectionOptions,
    /** `permessage-deflate` was agreed in the handshake. */
    private readonly deflate = false
  ) {
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
    socket.on('error', () => this.socket.destroy());
    socket.on('close', () =>
      this.ended(this.saidGoodbye?.code ?? 1006, this.saidGoodbye?.reason ?? '')
    );
  }

  get open(): boolean {
    return !this.closed && !this.closeSent;
  }

  /**
   * A reply the tab asked for (`requested`) does not count against the cap
   * (todo 836): 100,000 lines of backscroll is about 11.7 MB, and the tab that
   * asked for it was closed by the next push behind it.
   */
  send(text: string, requested = false): void {
    if (!this.open) return;
    if (!this.roomToWrite()) return;
    const bytes = this.textFrame(Buffer.from(text, 'utf8'));
    if (!requested) {
      this.socket.write(bytes);
      return;
    }
    this.requested += bytes.length;
    this.socket.write(bytes, () => {
      this.requested -= bytes.length;
    });
  }

  private textFrame(payload: Buffer): Buffer {
    if (!this.deflate || payload.length < this.options.deflateMinBytes) {
      return frame(OPCODE.text, payload);
    }
    const deflated = deflateRawSync(payload, { finishFlush: zlib.Z_SYNC_FLUSH });
    return frame(OPCODE.text, deflated.subarray(0, deflated.length - DEFLATE_TAIL.length), true);
  }

  /**
   * A peer that is not draining what it is sent is closed rather than
   * buffered for. 1008 is the policy code: nothing about the frames was
   * wrong, the tab simply stopped taking them.
   */
  private roomToWrite(): boolean {
    if (this.socket.writableLength - this.requested <= this.options.maxBufferedBytes) return true;
    this.close(1008, 'not reading');
    return false;
  }

  ping(): void {
    if (!this.open) return;
    this.socket.write(frame(OPCODE.ping, Buffer.alloc(0)));
  }

  /**
   * Say goodbye and end the stream. A close frame goes out once; the stream
   * is ended behind it rather than held open for the peer's echo, because a
   * peer that has gone never echoes and the server is the one holding a
   * socket for it.
   */
  close(code = 1000, reason = ''): void {
    if (this.closeSent || this.closed) return;
    this.closeSent = true;
    this.saidGoodbye = { code, reason };
    const text = Buffer.from(reason, 'utf8').subarray(0, 123);
    const payload = Buffer.alloc(2 + text.length);
    payload.writeUInt16BE(code, 0);
    text.copy(payload, 2);
    this.socket.write(frame(OPCODE.close, payload));
    this.socket.end();
  }

  private ended(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(code, reason);
  }

  /** Refuse the peer: close with the code that says why, and stop reading. */
  private fail(code: number, reason: string): void {
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    this.close(code, reason);
  }

  private feed(chunk: Buffer): void {
    if (this.closeSent) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0]!;
      const b1 = this.buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      // RSV1 is the compressed bit, on a message's first frame only, and only
      // once agreed; RSV2 and RSV3 mean nothing here.
      const deflated = (b0 & RSV1) !== 0;
      if ((b0 & 0x30) !== 0) return this.fail(1002, 'reserved bits set');
      if (deflated && (!this.deflate || opcode === OPCODE.continuation || opcode >= 0x8)) {
        return this.fail(1002, 'reserved bits set');
      }
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const wide = this.buffer.readBigUInt64BE(2);
        if (wide > BigInt(this.options.maxMessageBytes))
          return this.fail(1009, 'message too large');
        length = Number(wide);
        offset = 10;
      }
      // The client's frames are masked; that is the protocol, and an unmasked
      // one is a peer that is not a browser and not our bridge.
      if (!masked) return this.fail(1002, 'client frame not masked');
      if (length > this.options.maxMessageBytes) return this.fail(1009, 'message too large');
      if (this.buffer.length < offset + 4 + length) return;

      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ mask[i & 3]!;
      this.buffer = this.buffer.subarray(offset + 4 + length);

      if (opcode >= 0x8) {
        if (!fin || length > 125) return this.fail(1002, 'control frame malformed');
        this.control(opcode, payload);
        if (this.closeSent) return;
        continue;
      }

      if (opcode === OPCODE.binary) return this.fail(1003, 'binary frames are not accepted');
      if (opcode !== OPCODE.text && opcode !== OPCODE.continuation) {
        return this.fail(1002, 'unknown opcode');
      }
      if (opcode === OPCODE.text && this.fragments !== null) {
        return this.fail(1002, 'new message inside a fragmented one');
      }
      if (opcode === OPCODE.continuation && this.fragments === null) {
        return this.fail(1002, 'continuation with nothing to continue');
      }

      if (fin && this.fragments === null) {
        this.deliver(payload, deflated);
        continue;
      }
      if (this.fragments === null) this.fragmentsDeflated = deflated;
      this.fragments ??= [];
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > this.options.maxMessageBytes) {
        return this.fail(1009, 'message too large');
      }
      if (fin) {
        const whole = Buffer.concat(this.fragments);
        this.fragments = null;
        this.fragmentBytes = 0;
        this.deliver(whole, this.fragmentsDeflated);
      }
    }
  }

  private control(opcode: number, payload: Buffer): void {
    if (opcode === OPCODE.close) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      // Echo the close; the peer's own code and reason are what is reported.
      this.close(code === 1005 ? 1000 : code, '');
      this.ended(code, reason);
      return;
    }
    if (opcode === OPCODE.ping) {
      this.socket.write(frame(OPCODE.pong, payload));
      return;
    }
    if (opcode === OPCODE.pong) {
      this.onPong?.();
      return;
    }
    this.fail(1002, 'unknown control opcode');
  }

  private deliver(payload: Buffer, deflated: boolean): void {
    let raw = payload;
    if (deflated) {
      try {
        raw = inflateRawSync(Buffer.concat([payload, DEFLATE_TAIL]), {
          finishFlush: zlib.Z_SYNC_FLUSH,
          maxOutputLength: this.options.maxMessageBytes
        });
      } catch (error) {
        const tooLarge = (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE';
        this.fail(tooLarge ? 1009 : 1007, tooLarge ? 'message too large' : 'not deflate data');
        return;
      }
    }
    let text: string;
    try {
      text = this.decoder.decode(raw);
    } catch {
      this.fail(1007, 'text frame is not UTF-8');
      return;
    }
    this.onMessage?.(text);
  }
}

/**
 * Finish the handshake on an upgrade request and hand back the connection.
 *
 * The caller has already decided the request may be upgraded — the path, the
 * credentials and the origin are its questions, not the protocol's.
 */
export function acceptUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: ConnectionOptions
): WebSocketConnection {
  const key = String(request.headers['sec-websocket-key'] ?? '');
  const deflate = offersDeflate(request);
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      ...(deflate ? [`Sec-WebSocket-Extensions: ${DEFLATE_RESPONSE}`] : []),
      '',
      ''
    ].join('\r\n')
  );
  const connection = new WebSocketConnection(socket, options, deflate);
  // Bytes that arrived with the upgrade are the first frames.
  if (head.length > 0) socket.unshift(head);
  return connection;
}
