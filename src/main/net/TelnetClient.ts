/**
 * The engine's transport layer: one TCP socket, one Telnet parser, and the
 * decode pipeline that turns bytes on the wire into terminal-ready text.
 *
 * Deliberately knows nothing about Electron, IPC or game grammar, so it can be
 * driven from a test harness or a headless process.
 */
import net from 'node:net';
import { EventEmitter } from 'node:events';
import iconv from 'iconv-lite';

import { TelnetParser } from './TelnetParser';
import {
  applyQuirks,
  splitTrailingEscape,
  DEFAULT_QUIRKS,
  type QuirkOptions
} from './stream-quirks';
import type {
  ConnectionTarget,
  NegotiatedOptions,
  StreamEncoding,
  TelnetEvent,
  TerminalSize
} from '../../shared/types';
import { tuning } from '../app/tuning';

export interface TelnetClientEvents {
  /** Socket is open; Telnet negotiation may still be in flight. */
  connect: [];
  /** Decoded, quirk-adjusted text ready for the terminal. */
  data: [text: string];
  /** Raw payload bytes, framing removed — the parser's input, pre-decode. */
  bytes: [payload: Buffer];
  /** A prompt boundary signalled by the server via GA or EOR. */
  prompt: [];
  /** A Telnet negotiation exchange, for diagnostics. */
  telnet: [event: TelnetEvent];
  /** Connection closed. `graceful` is false when the peer or network dropped it. */
  close: [graceful: boolean];
  error: [error: Error];
}

/**
 * Default geometry reported over NAWS before the renderer has measured itself.
 * 80x24 is what every BBS expects, so it is a safe opening bid.
 */
const FALLBACK_SIZE: TerminalSize = { cols: 80, rows: 24 };

export declare interface TelnetClient {
  on<K extends keyof TelnetClientEvents>(
    event: K,
    listener: (...args: TelnetClientEvents[K]) => void
  ): this;
  emit<K extends keyof TelnetClientEvents>(event: K, ...args: TelnetClientEvents[K]): boolean;
}

export class TelnetClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private parser: TelnetParser;
  private encoding: StreamEncoding = 'cp437';
  private quirks: QuirkOptions;

  /** Trailing fragment of an incomplete escape sequence, carried between chunks. */
  private escapeCarry = '';
  private size: TerminalSize = { ...FALLBACK_SIZE };
  /** Last geometry actually put on the wire, so repeats are not resent. */
  private reported: TerminalSize | null = null;
  private nawsTimer: NodeJS.Timeout | null = null;
  /** Set on an explicit `disconnect()` so `close` can report a graceful exit. */
  private closingIntentionally = false;

  /**
   * How long to wait for the socket to open. See `tuning.net.connectTimeoutMs`.
   *
   * Injectable so the deadline can be driven in a test: a real unanswered SYN
   * cannot be produced on demand against the one realm this project dials, so
   * the alternative is not testing the one path that exists to stop the client
   * wedging.
   */
  private readonly connectTimeoutMs: number;

  constructor(
    quirks: QuirkOptions = DEFAULT_QUIRKS,
    connectTimeoutMs = tuning().net.connectTimeoutMs
  ) {
    super();
    this.quirks = quirks;
    this.connectTimeoutMs = connectTimeoutMs;
    this.parser = this.createParser();
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  get negotiated(): NegotiatedOptions {
    return {
      localEnabled: this.parser.localEnabled,
      remoteEnabled: this.parser.remoteEnabled,
      binary: this.parser.binary,
      suppressGoAhead: this.parser.suppressGoAhead,
      remoteEcho: this.parser.remoteEcho
    };
  }

  /**
   * Opens the connection. Resolves once the socket is writable; Telnet option
   * negotiation continues asynchronously afterwards and is reported via events.
   */
  connect(target: ConnectionTarget): Promise<void> {
    this.disconnect();

    this.encoding = target.encoding;
    this.escapeCarry = '';
    this.reported = null;
    this.closingIntentionally = false;
    if (this.nawsTimer) {
      clearTimeout(this.nawsTimer);
      this.nawsTimer = null;
    }
    // A fresh parser per connection: option state must never leak across
    // sessions, which is how negotiation loops appear on reconnect.
    this.parser = this.createParser();

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: target.host, port: target.port });
      this.socket = socket;

      // Nagle batches our single-keystroke writes into 40ms clumps, which is
      // fatal for a game where round timing matters.
      socket.setNoDelay(true);

      /*
       * The dial has a deadline of its own.
       *
       * A host that refuses gives us `ECONNREFUSED` immediately, but one that
       * silently drops the SYN — a firewall, a dead address on a live subnet —
       * gives us nothing at all until the OS gives up, which on Linux is around
       * two minutes. Nothing here settled in the meantime: the promise stayed
       * pending, the session stayed in `connecting`, and `BUSY_PHASES` refused
       * every further attempt. The client was wedged with no way back except
       * restarting it.
       *
       * `socket.setTimeout` is the wrong tool: that is an *idle* timeout, and
       * it would fire during any quiet moment of a game the player is still
       * playing. This one covers the dial and nothing else — it is cleared the
       * moment the socket connects or fails.
       */
      let dialTimer: NodeJS.Timeout | null = setTimeout(() => {
        dialTimer = null;
        socket.removeListener('connect', onConnect);
        socket.removeListener('error', onConnectError);
        this.teardown();
        reject(
          new Error(
            `No answer from ${target.host}:${target.port} after ${this.connectTimeoutMs / 1000}s.`
          )
        );
      }, this.connectTimeoutMs);

      /** Deterministic cleanup for the dial deadline, whichever way it ends. */
      const clearDial = (): void => {
        if (dialTimer === null) return;
        clearTimeout(dialTimer);
        dialTimer = null;
      };

      const onConnectError = (error: Error): void => {
        clearDial();
        socket.removeListener('connect', onConnect);
        this.teardown();
        reject(error);
      };

      const onConnect = (): void => {
        clearDial();
        socket.removeListener('error', onConnectError);
        /*
         * Guarded, because `EventEmitter` *throws* on an `error` event with no
         * listener -- and in the main process that is not a rejected promise,
         * it is the application going away.
         *
         * There is a real window for it: `disconnect()` calls `end()` and only
         * destroys the socket 250 ms later, so a peer that resets the
         * connection in between arrives after the owner has stopped listening.
         * A socket error during teardown is not news -- `close` already
         * reports the disconnection -- so dropping it is correct as well as
         * safe.
         */
        socket.on('error', (error) => {
          if (this.listenerCount('error') > 0) this.emit('error', error);
        });
        this.emit('connect');
        resolve();
      };

      socket.once('error', onConnectError);
      socket.once('connect', onConnect);

      socket.on('data', (chunk) => this.ingest(chunk));
      socket.on('close', () => {
        const graceful = this.closingIntentionally;
        this.teardown();
        this.emit('close', graceful);
      });
    });
  }

  disconnect(): void {
    if (!this.socket) return;
    this.closingIntentionally = true;
    this.socket.end();
    // `end()` waits for the FIN handshake; destroy on the next tick guarantees
    // the socket is gone even if the peer never replies.
    const socket = this.socket;
    setTimeout(() => socket.destroy(), tuning().net.destroyDelayMs).unref();
  }

  /**
   * Sends user input. Accepts either whole lines or single keystrokes.
   *
   * Two NVT normalisations happen here rather than in the UI, because they are
   * protocol concerns: a lone CR becomes the RFC 854 CR LF end-of-line, and DEL
   * (what browsers emit for Backspace) becomes BS (what these servers expect).
   */
  send(text: string): void {
    if (!this.socket || this.socket.destroyed) return;
    const normalised = text.replace(/\r(?!\n)/g, '\r\n').replace(/\x7f/g, '\b');
    const encoded = iconv.encode(normalised, this.encoding);
    this.socket.write(this.parser.encode(encoded.toString('latin1')));
  }

  /**
   * Records new terminal geometry and reports it over NAWS if negotiated.
   *
   * Deduplicated against the last reported geometry: the session replays the
   * current size on connect, and the renderer reports on every layout change,
   * so without this the server and the diagnostics log both see redundant
   * updates.
   */
  resize(size: TerminalSize): void {
    this.size = size;
    if (!this.socket || this.socket.destroyed) return;

    if (this.nawsTimer) clearTimeout(this.nawsTimer);
    this.nawsTimer = setTimeout(() => this.flushWindowSize(), tuning().net.nawsCoalesceMs);
    this.nawsTimer.unref?.();
  }

  // ---------------------------------------------------------------- internals

  /** Puts the settled geometry on the wire, if it differs from the last report. */
  private flushWindowSize(): void {
    this.nawsTimer = null;
    if (!this.socket || this.socket.destroyed) return;

    const size = this.size;
    if (this.reported?.cols === size.cols && this.reported.rows === size.rows) return;

    const report = this.parser.windowSizeReport(size);
    if (report.length === 0) return;

    this.socket.write(report);
    this.reported = { ...size };
    // Emitted here rather than inside the parser because this path is driven by
    // the UI, not by anything arriving on the wire — but the diagnostics pane
    // must still show it, or the log silently under-reports what we sent.
    this.emit('telnet', {
      at: Date.now(),
      direction: 'out',
      summary: `SB NAWS ${size.cols}x${size.rows} SE`
    });
  }

  private createParser(): TelnetParser {
    return new TelnetParser({
      terminalTypes: ['ANSI', 'XTERM-256COLOR', 'UNKNOWN'],
      charset: this.encoding === 'cp437' ? 'CP437' : 'UTF-8',
      // The parser calls this when it agrees to perform NAWS and reports the
      // size itself. Recording it here keeps the dedupe in `resize` honest, so
      // the session replaying the current geometry on connect does not put a
      // duplicate report on the wire.
      getWindowSize: () => {
        this.reported = { ...this.size };
        return this.size;
      }
    });
  }

  private ingest(chunk: Buffer): void {
    const result = this.parser.receive(chunk);

    for (const event of result.events) this.emit('telnet', event);
    if (result.reply.length > 0 && this.socket && !this.socket.destroyed) {
      this.socket.write(result.reply);
    }

    if (result.data.length > 0) {
      this.emit('bytes', result.data);

      // Decode after framing removal, never before: an IAC byte inside a CP437
      // decode would otherwise become a printable glyph.
      const decoded = iconv.decode(result.data, this.encoding);
      const combined = this.escapeCarry + decoded;
      const { emit, hold } = splitTrailingEscape(combined);
      this.escapeCarry = hold;

      if (emit.length > 0) this.emit('data', applyQuirks(emit, this.quirks));
    }

    for (let i = 0; i < result.promptMarks.length; i += 1) this.emit('prompt');
  }

  private teardown(): void {
    if (this.nawsTimer) {
      clearTimeout(this.nawsTimer);
      this.nawsTimer = null;
    }
    if (!this.socket) return;
    this.socket.removeAllListeners();
    this.socket.destroy();
    this.socket = null;
  }
}
