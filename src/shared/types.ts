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
  /**
   * Who ended the last connection. Null while one has not ended.
   *
   * Three answers because the window has to tell them apart and `detail` is a
   * sentence: comparing a translated string to decide whether a character was
   * dropped is the guess this codebase refuses everywhere else. `player` is
   * Disconnect, a dial at another realm, typing your way out to the BBS menu
   * and quitting; `client` is the low-health hang-up acting for somebody who
   * is not there; `realm` is the far end going without anybody here asking,
   * which is the one that leaves a character standing in a lair.
   */
  endedBy: ConnectionEnd | null;
  /** Telnet options the engine and peer have agreed on, for diagnostics. */
  negotiated: NegotiatedOptions;
}

/** Who ended a connection. See `ConnectionState.endedBy`. */
export type ConnectionEnd = 'player' | 'client' | 'realm';

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
/**
 * The pictures the console can lay over a line: a place's kind beside a
 * room's name, and — on a line the client drew itself (`ui.rewrites`) — a
 * body slot, or what putting a thing on would come to. A closed list, so the
 * renderer's glyph table (`marks.ts`) is complete by type.
 */
export const MARK_ICONS = [
  'shop',
  'bank',
  'temple',
  'inn',
  'trainer',
  /* the equip gate, in the pack's own three words */
  'wear',
  'worn',
  'blocked',
  /* where a thing is worn, by the listing's word for the slot */
  'weapon',
  'offhand',
  'head',
  'hands',
  'finger',
  'feet',
  'arms',
  'back',
  'neck',
  'legs',
  'waist',
  'torso',
  'wrist',
  'ears',
  'face',
  'readied',
  'kit'
] as const;
export type MarkIcon = (typeof MARK_ICONS)[number];

/**
 * A glyph laid over cells *inside* a line the client drew, at the column it
 * starts in. Two cells of the row are left blank for it. With `commands` it
 * is a button, sent down the path a keystroke takes; without, a statement,
 * and `label` is the tooltip that says which.
 */
export interface InlineGlyph {
  x: number;
  icon: MarkIcon;
  label: string;
  commands?: string[];
}

export interface TerminalMark {
  /**
   * The glyph in the margin before the line, which indents it two cells.
   * Absent on a line the client drew, whose glyphs sit inside it (`inline`).
   */
  icon?: MarkIcon;
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
  /** Glyphs inside the line, on a line the client drew (`ui.rewrites`). */
  inline?: InlineGlyph[];
}

/**
 * A button beside a room's name that main runs, rather than one that sends
 * text.
 *
 * The closed list `gear:act` already keeps, applied to the console: what
 * crosses the wire is a name from this list and never a command, because the
 * figures a banking command needs live in main and a renderer composing one
 * would be a second reading of them.
 */
export const TERMINAL_ACTIONS = ['deposit-all'] as const;
export type TerminalActionName = (typeof TERMINAL_ACTIONS)[number];

interface TerminalActionFace {
  /** What the button says. Short — it has to fit on the line's own row. */
  label: string;
  /** The tooltip, and what a screen reader gets: the label alone is terse. */
  title: string;
}

/**
 * A button whose payload is its commands, fixed when the line was drawn.
 *
 * Sent verbatim down the path a keystroke takes, so the tracker observes each
 * one, a walk stands down and the capture records it — the Talk card's rule,
 * for the same reason: a second route to the socket is a second copy of all of
 * that, and copies drift.
 *
 * **A command composed here can only carry facts that do not go stale**, which
 * is why the realm's own exit text is what this shape is for. A *number* must
 * not be baked into one: see `TerminalIntentAction`.
 */
export interface TerminalCommandAction extends TerminalActionFace {
  commands: string[];
  act?: never;
}

/**
 * A button that names an action for main to run when it is pressed.
 *
 * **This exists because a refresh cannot refresh its own ask.** `Deposit All`
 * used to be three commands — `i`, `deposit <n>`, `bank` — composed together
 * when the room's name printed, on the documented belief that "the `i` in
 * front of it is what makes that figure current by the time the deposit is
 * read". It never could: `<n>` was already a literal by then, and all three
 * strings left the client in the same millisecond
 * (`logs/2026-09-04_20-39-52_festus`, t=771361), with the corrected `Wealth:`
 * arriving 71ms after the deposit was already on the wire. The purse had
 * drifted by two levels' training, the vault was asked for 2,200 copper the
 * character did not have, and this server refuses that in **silence** — so the
 * button did nothing, twice, and only worked on the press after a bare Enter
 * happened to reprint the room and compose it again.
 *
 * So the amount is not decided here at all. Main sends the `i`, waits for the
 * listing that answers it, and composes the deposit from *that*. A fact fans
 * out and the action funnels in, which is the shape everything else automated
 * already follows.
 */
export interface TerminalIntentAction extends TerminalActionFace {
  act: TerminalActionName;
  commands?: never;
}

/** One button beside a recognised line. */
export type TerminalAction = TerminalCommandAction | TerminalIntentAction;

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
