/**
 * Noticing that a connection has died without the socket saying so.
 *
 * Everything else in this client that reacts to a lost connection reacts to a
 * socket that **closed**: `SessionManager`'s `close` handler decides whether
 * anybody asked for it, and `Reconnect` dials back the remainder. None of that
 * can see the failure this exists for. A NAT table that forgot the flow, a host
 * that went away without a FIN, a link that dropped mid-round: each leaves a
 * writable socket nothing will ever answer again, and the client sat at one
 * reporting `connected`, with the loop still nominally running, until somebody
 * came back to the keyboard and found out.
 *
 * Two rules decide what it measures.
 *
 * - **Only while an answer is owed.** The clock starts when a command reaches
 *   the wire and stops at the next byte in. Wire silence on its own is the
 *   wrong reading twice over: this realm repaints its status line unprompted
 *   every thirty seconds (measured — `Routines.noteSent`), so fifteen seconds
 *   of quiet is ordinary, and a client that has asked for nothing is owed
 *   nothing. Every command this server family takes is answered with at least
 *   a status line, and promptly, so an unanswered one is a real signal.
 * - **A keystroke is not a command.** A half-typed line produces no answer at
 *   all when the server is doing its own echo, so arming on one would hang up
 *   on a player who started typing and went to make tea. Only a line that has
 *   gone out — including the bare Enter the keep-alive sends — arms it.
 *
 * What it does when it fires is hand the connection to the machinery that
 * already exists: hang up as a **loss**, which is the only thing `Reconnect`
 * redials, and say so out loud. It never decides whether to dial back — that is
 * the character's own `autoReconnect`.
 *
 * The threshold is `tuning.reconnect.silentForMs`, read at each arm so a change
 * reaches a session that is already running; `0` switches it off.
 */
import { tuning } from '../app/tuning';

export interface LinkWatchEvents {
  /** The link is dead. Hang up as a loss and say so. */
  dead(seconds: number): void;
}

export class LinkWatch {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly events: LinkWatchEvents) {}

  /** Whether an answer is currently owed. Read by the tests and nothing else. */
  get waiting(): boolean {
    return this.timer !== null;
  }

  /**
   * A command reached the wire.
   *
   * The first one arms; the ones behind it do not re-arm, because the deadline
   * belongs to the *oldest* unanswered command. Re-arming per command would let
   * a character that sends every three seconds hold a dead link open for ever.
   */
  noteSent(): void {
    if (this.timer !== null) return;
    const after = tuning().reconnect.silentForMs;
    if (after <= 0) return;
    this.timer = setTimeout(() => this.expire(after), after);
    // A pending deadline does not owe the process another tick: a client told
    // to quit should not be held open by a connection it is about to drop.
    this.timer.unref();
  }

  /** A byte arrived. Whatever was owed has been answered. */
  noteReceived(): void {
    this.clear();
  }

  /** The socket opened or closed: nothing is owed across one. */
  reset(): void {
    this.clear();
  }

  /** Deterministic cleanup: the timer is owned here, so it is released here. */
  dispose(): void {
    this.clear();
  }

  private expire(after: number): void {
    this.timer = null;
    this.events.dead(Math.round(after / 1000));
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
