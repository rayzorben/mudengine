/**
 * Records a session in full, for offline analysis.
 *
 * Distinct from `SessionLog`, which strips ANSI and exists to be read by a
 * person. This exists to be read by a *parser*, and by whoever is writing the
 * next one: raw bytes, decoded text with escape sequences intact, framed lines,
 * and the commands that provoked them, all timestamped and correlated.
 *
 * The reason it exists: pattern work done against remembered line shapes is
 * guesswork. The `who` and inventory patterns in this project were first
 * written from a different client's source without anyone having seen this
 * server's actual output — which is exactly the mistake a capture makes
 * impossible. Play manually, capture, then write patterns against what the
 * server really sent.
 *
 * One JSON object per line:
 *
 *     {"t":0,"k":"meta","host":"gmud-tgs","port":2427,"encoding":"cp437"}
 *     {"t":118,"k":"in","raw":"<base64 of the bytes off the socket>"}
 *     {"t":119,"k":"text","s":"[1;36mBank of Godfrey[0m\r\n"}
 *     {"t":121,"k":"line","s":"Bank of Godfrey","term":"newline"}
 *     {"t":900,"k":"out","s":"who"}
 *
 * `raw` is the bytes *after* Telnet framing is stripped but *before* decoding,
 * so an encoding bug is reproducible from the file alone.
 */
import fs from 'node:fs';
import path from 'node:path';

import { slug, stamp } from './filename';
import { errorMessage } from '../../shared/values';
import type { ConnectionTarget, StreamLine } from '../../shared/types';

export interface SessionCaptureOptions {
  directory: string;
  maxBytes: number;
  onProblem?: ((message: string) => void) | undefined;
  /**
   * The capture has created its file. Said here rather than at the dial,
   * because the file is created lazily — see `ensureStream`.
   */
  onOpened?(file: string): void;
}

export class SessionCapture {
  private stream: fs.WriteStream | null = null;
  private written = 0;
  private stopped = false;
  private startedAt = 0;
  private file = '';
  /** The opening record, written ahead of the first real one. */
  private meta: Record<string, unknown> | null = null;

  constructor(private readonly options: SessionCaptureOptions) {}

  get path(): string {
    return this.file;
  }

  /**
   * Whether this capture would record something now. True from `open`: the
   * file is created lazily, so one that has recorded nothing is still armed.
   */
  get active(): boolean {
    return !this.stopped && (this.stream !== null || this.file.length > 0);
  }

  /**
   * `session` names the file, for the same reason `SessionLog` uses it: two
   * characters on one BBS otherwise write filenames that differ by nothing. The
   * `meta` record below still carries the address.
   */
  open(target: ConnectionTarget, at = new Date(), session = ''): void {
    this.close();
    this.stopped = false;
    this.written = 0;
    this.startedAt = at.getTime();

    const label = slug(session.length > 0 ? session : `${target.host}_${target.port}`);
    /*
     * Named now, created on the first record. `SessionHost` rotates the capture
     * before every dial, so an eager open wrote a one-record file per *attempt*
     * — one every fifteen seconds behind auto-reconnect. See `SessionLog.open`.
     */
    this.file = path.join(this.options.directory, `${stamp(at)}_${label}.mudcap.jsonl`);
    this.meta = {
      k: 'meta',
      session,
      host: target.host,
      port: target.port,
      encoding: target.encoding,
      startedAt: at.toISOString()
    };
  }

  /** Creates the file on the first record worth keeping, `meta` ahead of it. */
  private ensureStream(): boolean {
    if (this.stream) return true;
    if (this.stopped || this.file.length === 0) return false;
    try {
      fs.mkdirSync(this.options.directory, { recursive: true });
      this.stream = fs.createWriteStream(this.file, { flags: 'a' });
      this.stream.on('error', (error) => this.fail(`Capture write failed: ${error.message}`));
      const meta = this.meta;
      this.meta = null;
      // Announced here rather than at the dial: "Capturing this session to X"
      // is true exactly when X exists, and said at the dial it was one console
      // line per *attempt* behind auto-reconnect.
      this.options.onOpened?.(this.file);
      if (meta) {
        const line = JSON.stringify({ t: 0, ...meta }) + '\n';
        this.written += Buffer.byteLength(line, 'utf8');
        this.stream.write(line);
      }
      return true;
    } catch (error) {
      this.fail(`Could not open capture: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Bytes off the socket, Telnet-stripped and not yet decoded. */
  bytes(buffer: Buffer): void {
    this.record({ k: 'in', raw: buffer.toString('base64') });
  }

  /** Decoded text, escape sequences intact. */
  text(value: string): void {
    this.record({ k: 'text', s: value });
  }

  /** A framed line, as the parser will see it. */
  line(value: StreamLine): void {
    this.record({ k: 'line', s: value.plain, raw: value.text, term: value.terminator });
  }

  /** A command the client sent, whoever decided to send it. */
  out(command: string, source: 'user' | 'automation' = 'user'): void {
    this.record({ k: 'out', s: command, src: source });
  }

  /**
   * Stops recording, and resolves once the last line is actually on disk.
   *
   * `end()` alone only *asks*: a `WriteStream` flushes on the event loop, so
   * anything reading the file straight afterwards can see a short file. The
   * tests here read it, and slept 60 ms instead — which passes on a quiet
   * machine and fails on a busy one, which is what a flake is.
   *
   * The quit path deliberately does **not** await this. `teardown()` is
   * synchronous by design — it runs from a signal handler, where returning to
   * the event loop is not on offer — and what a capture can lose there is the
   * last few lines of a *development* recording that is off by default. The
   * things that must survive a quit are the lore, the realm memory and the
   * fight log, and all three write synchronously.
   */
  close(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    this.file = '';
    if (!stream) return Promise.resolve();
    return new Promise((resolve) => {
      stream.end(() => resolve());
    });
  }

  private record(entry: Record<string, unknown>): void {
    if (!this.active || !this.ensureStream()) return;
    const line = JSON.stringify({ t: Date.now() - this.startedAt, ...entry }) + '\n';

    const size = Buffer.byteLength(line, 'utf8');
    if (this.written + size > this.options.maxBytes) {
      this.fail('Capture reached its size limit; no longer recording.');
      return;
    }

    this.written += size;
    this.stream?.write(line);
  }

  private fail(message: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stream?.end();
    this.stream = null;
    this.options.onProblem?.(message);
  }
}
