/**
 * Types shared across the main, preload and renderer processes.
 * This module must stay dependency-free so it can be imported from any context.
 */

/** How the engine describes a remote endpoint. */
export interface ConnectionTarget {
  /** Hostname or IP of the BBS / MUD server. */
  host: string;
  /** TCP port. MajorMUD hosts commonly use 23, 2323 or 4000. */
  port: number;
  /**
   * Character encoding of the byte stream once Telnet framing is removed.
   * `cp437` is correct for classic BBS art; `utf8` for modern derivatives.
   */
  encoding: StreamEncoding;
}

export type StreamEncoding = 'cp437' | 'utf8' | 'latin1';

/**
 * Whether two targets are the same realm: the same host and port.
 *
 * The encoding is deliberately not compared. It says how this client reads
 * the bytes, not where they come from, and a loop or a journey carried across
 * a reconnect is a list of rooms *in a realm* — which is what the address
 * names. Hosts are compared case-insensitively because DNS is.
 */
export function sameTarget(a: ConnectionTarget, b: ConnectionTarget): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port;
}

const ENCODINGS: readonly StreamEncoding[] = ['cp437', 'utf8', 'latin1'];

/**
 * Narrows a payload that crossed the bridge into a `ConnectionTarget`, or
 * rejects it.
 *
 * Parse, do not validate: the caller gets the typed value or `null` and cannot
 * carry on with something merely checked.
 *
 * The other payload a window sends that reaches the network. A port is the part
 * worth being strict about — it is handed to the socket layer, where anything
 * outside 1-65535 is a throw rather than a refusal, and a throw in an IPC
 * handler is a rejected promise nobody is holding.
 */
export function asConnectionTarget(value: unknown): ConnectionTarget | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<ConnectionTarget>;

  if (typeof candidate.host !== 'string' || candidate.host.trim().length === 0) return null;
  if (typeof candidate.port !== 'number' || !Number.isInteger(candidate.port)) return null;
  if (candidate.port < 1 || candidate.port > 65535) return null;
  if (!ENCODINGS.includes(candidate.encoding as StreamEncoding)) return null;

  return {
    host: candidate.host.trim(),
    port: candidate.port,
    encoding: candidate.encoding as StreamEncoding
  };
}

export type ConnectionPhase =
  | 'idle'
  | 'resolving'
  | 'connecting'
  | 'negotiating'
  | 'connected'
  | 'closing'
  | 'closed'
  | 'error';

export interface ConnectionState {
  phase: ConnectionPhase;
  target: ConnectionTarget | null;
  /** Epoch ms at which the socket became writable, or null. */
  connectedAt: number | null;
  /** Human-readable reason for the last transition to `closed` or `error`. */
  detail: string | null;
  /** Telnet options the engine and peer have agreed on, for diagnostics. */
  negotiated: NegotiatedOptions;
}

export interface NegotiatedOptions {
  /** Options the local side has agreed to perform (we sent WILL, peer sent DO). */
  localEnabled: string[];
  /** Options the remote side is performing (peer sent WILL, we sent DO). */
  remoteEnabled: string[];
  /** True once the server has requested binary transmission in either direction. */
  binary: boolean;
  /** True while the server has suppressed go-ahead (normal for MUDs). */
  suppressGoAhead: boolean;
  /** True while the server has echo enabled on its side (password prompts). */
  remoteEcho: boolean;
}

/** A decoded chunk of server output, ready for the terminal. */
/**
 * A glyph the console draws beside a line it recognised.
 *
 * Outside the character grid, on purpose: a decoration is an element laid
 * over the cell row, so nothing the server lays out in rows and columns moves
 * and no escape sequence that counts either ever sees it.
 */
export interface TerminalMark {
  icon: 'shop' | 'bank' | 'temple' | 'inn' | 'trainer';
  /** The tooltip, and what a screen reader gets. */
  label: string;
  /**
   * What can be done here, drawn as buttons after the line's text.
   *
   * The same decoration layer as the glyph and for the same reason — a button
   * inside the grid would move everything the server laid out beside it — so
   * these sit *after* the last cell of the name rather than indenting it.
   *
   * Absent on a line that recognises a place but offers nothing to do in it,
   * which is most of them: an action exists only where the realm data or the
   * realm's own command table names the exact command, never where the client
   * would have to guess one. A button that sends a command the server does not
   * take is worse than no button — it broadcasts the text to the room.
   */
  actions?: TerminalAction[];
}

/**
 * One button beside a recognised line.
 *
 * `command` is sent verbatim down the path a keystroke takes, so the tracker
 * observes it, a walk stands down and the capture records it — the Talk card's
 * rule, for the same reason: a second route to the socket is a second copy of
 * all of that, and copies drift.
 */
export interface TerminalAction {
  /** What the button says. Short — it has to fit on the line's own row. */
  label: string;
  /**
   * The commands sent verbatim, in order, when it is pressed.
   *
   * A list rather than one string because an action may need to *refresh a
   * fact before acting on it*: `Deposit All` sends `i` and then the deposit,
   * so the figure it names is the one the listing just restated rather than
   * whatever the maintained total had drifted to. Each goes down the path a
   * keystroke takes, so the tracker sees each one and the queue paces them.
   */
  commands: string[];
  /** The tooltip, and what a screen reader gets: the label alone is terse. */
  title: string;
}

export interface StreamChunk {
  /** Monotonic sequence number; lets the renderer detect dropped frames. */
  seq: number;
  /** Epoch ms at which the bytes left the socket. */
  at: number;
  /**
   * What the terminal paints: framed lines and the unterminated tail, escape
   * sequences intact, minus whatever the feed withheld. See `TerminalFeed`.
   */
  text: string;
  /**
   * Lines in `text` worth decorating, by the offset the line starts at.
   * Absent on a chunk with nothing to mark, which is nearly all of them.
   */
  marks?: Array<{ offset: number; mark: TerminalMark }>;
}

/**
 * How a framed line was terminated.
 *
 * `repaint` is the one that matters: this game family rewrites its status line
 * in place with `ESC[79D ESC[K` rather than a newline, so CRLF alone does not
 * frame the stream. See docs/reference-codebases.md §2.4.
 */
export type LineTerminator = 'newline' | 'repaint' | 'flush';

/** One framed line of server output, ANSI intact. */
export interface StreamLine {
  /** Monotonic within a session. */
  seq: number;
  at: number;
  /** The line as it arrived, escape sequences included. */
  text: string;
  /** The same with ANSI and the terminator removed — what a parser matches. */
  plain: string;
  terminator: LineTerminator;
}

/** Diagnostic record of a Telnet negotiation exchange. */
export interface TelnetEvent {
  at: number;
  direction: 'in' | 'out';
  /** e.g. "DO TERMINAL-TYPE", "SB NAWS 0 80 0 24 SE" */
  summary: string;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

// Presentation defaults — terminal font, scrollback, connection target — live
// in `./config.ts`, which is the single source of truth the YAML options file
// normalises into. Nothing here should restate them.
