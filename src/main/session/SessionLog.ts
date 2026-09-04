/**
 * Appends the decoded session to a file.
 *
 * A MUD client that cannot tell you what happened forty seconds ago is missing
 * the thing you reach for after every death. The terminal's backscroll covers
 * the session; this covers the ones before it.
 *
 * Three properties matter more than throughput:
 *
 * - **Logging can never take the session down.** Every filesystem failure is
 *   swallowed and disables the log for the rest of the session rather than
 *   propagating into the socket path.
 * - **Writes never block the stream.** Appends go through a write stream and
 *   are fire-and-forget; a slow disk delays the log, not the terminal.
 * - **It stops rather than filling the disk.** A client left connected
 *   overnight must not be able to consume a partition unattended, so the log
 *   closes itself at `maxBytes` and says so.
 *
 * ANSI is stripped on the way in. The raw stream is reproducible from the wire
 * and unreadable in a text editor; what makes a log worth keeping is being able
 * to grep it.
 */
import fs from 'node:fs';
import path from 'node:path';

import { slug, stamp } from './filename';
import { stripAnsi } from '../net/LineTokenizer';
import type { ConnectionTarget } from '../../shared/types';
import { errorMessage } from '../../shared/values';

export interface SessionLogOptions {
  /** Directory to write into. Created if missing. */
  directory: string;
  /** Stop appending past this many bytes. */
  maxBytes: number;
  /** Reports the first failure, and the cap being reached. */
  onProblem?: ((message: string) => void) | undefined;
}

export class SessionLog {
  private stream: fs.WriteStream | null = null;
  /** Written ahead of the first payload, so an unused log leaves no file. */
  private header = '';
  private written = 0;
  private stopped = false;
  private file = '';

  constructor(private readonly options: SessionLogOptions) {}

  /** Absolute path being written, or '' if logging is not active. */
  get path(): string {
    return this.file;
  }

  /**
   * Whether this log would record something written to it now.
   *
   * True from `open` rather than from the first byte: the file is created
   * lazily, so a log that has recorded nothing yet is still armed.
   */
  get active(): boolean {
    return !this.stopped && (this.stream !== null || this.file.length > 0);
  }

  /**
   * Opens a log for a new session. Closes any previous one first, so a
   * reconnect starts a fresh file rather than interleaving two sessions.
   *
   * The filename is keyed by *session*, not by host and port. Two characters on
   * the same BBS connecting in the same second produced names that differed by
   * nothing — and the question anyone actually asks of a session log is "what
   * happened to Thorn", not "what happened on port 2427". The header line below
   * still records the address.
   */
  open(target: ConnectionTarget, at = new Date(), session = ''): void {
    void this.close();
    this.stopped = false;
    this.written = 0;

    const label = slug(session.length > 0 ? session : `${target.host}_${target.port}`);
    /*
     * **The name and the header are decided now; the file is not created until
     * something is actually written to it.**
     *
     * `SessionHost` rotates the log before every dial, so an eager open made a
     * file per *attempt* rather than per connection — and with auto-reconnect
     * that is one every fifteen seconds. A router down overnight is roughly
     * 1,920 empty `.log` files and as many one-record captures by morning, and
     * `npm run check:secrets` walks the whole directory. A file holding only
     * the header it was opened with is a file with nothing in it.
     */
    this.file = path.join(this.options.directory, `${stamp(at)}_${label}.log`);
    this.header = `--- session ${target.host}:${target.port} (${target.encoding}) ---\n`;
  }

  /**
   * Creates the file on the first thing worth putting in it, header first.
   *
   * Returns whether there is a stream to write to; a failure here reports once
   * and stops the log for the session, exactly as a write failure does.
   */
  private ensureStream(): boolean {
    if (this.stream) return true;
    if (this.stopped || this.file.length === 0) return false;
    try {
      fs.mkdirSync(this.options.directory, { recursive: true });
      this.stream = fs.createWriteStream(this.file, { flags: 'a' });
      // A stream error after open — disk full, media removed — arrives here
      // rather than as an unhandled 'error' event that would take the process
      // down. Node destroys the stream itself; we only have to stop feeding it.
      this.stream.on('error', (error) => this.fail(`Session log write failed: ${error.message}`));
      const header = this.header;
      this.header = '';
      this.written += Buffer.byteLength(header, 'utf8');
      this.stream.write(header);
      return true;
    } catch (error) {
      this.fail(`Could not open session log: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Appends decoded server output. ANSI is stripped; CR is normalised away. */
  write(text: string): void {
    if (!this.active) return;
    this.append(stripAnsi(text).replace(/\r\n?/g, '\n'));
  }

  /**
   * Stops recording, and resolves once the last line is actually on disk.
   *
   * `end()` alone only *asks*: a `WriteStream` flushes on the event loop, so
   * anything reading the file straight afterwards can see a short one. The same
   * shape `SessionCapture.close` has, and for the same reason — the tests read
   * the file, and sleeping instead is a race that passes on a quiet machine.
   *
   * The quit path does not await it. `teardown()` is synchronous by design, and
   * what a log can lose there is the last line or two of a transcript whose
   * whole purpose is to still be there tomorrow.
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

  private append(text: string): void {
    if (!this.ensureStream() || !this.stream) return;

    const size = Buffer.byteLength(text, 'utf8');
    if (this.written + size > this.options.maxBytes) {
      this.fail(
        `Session log reached its ${Math.round(this.options.maxBytes / 1024 / 1024)} MB limit; ` +
          'no longer recording.'
      );
      return;
    }

    this.written += size;
    this.stream.write(text);
  }

  /** Disables logging for the rest of the session and reports why, once. */
  private fail(message: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stream?.end();
    this.stream = null;
    this.options.onProblem?.(message);
  }
}
