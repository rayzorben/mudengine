/**
 * Noticing that a connection has died without the socket saying so: a NAT
 * table that forgot the flow, a host gone without a FIN. It counts only while
 * an answer is owed, and on expiry says which and hangs up as a loss, so the
 * loop is held and `Reconnect` decides. Two things can be owed:
 *
 * - `reply`: a line reached the wire, and the next byte in pays it.
 * - `prompt`: on the way in, the next prompt is owed after the socket opens
 *   and after each login answer. The echo of the answer does not pay it.
 *
 * `tuning.reconnect.silentForMs` is read at each arm; `0` switches both off. See
 * `mudengine-session` decisions › *A dead link is noticed by what is owed, not by silence*.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';

/** What the far end owes: any byte back, or on the way in its next prompt. */
type Owed = 'reply' | 'prompt';

export interface LinkWatchSession {
  /** Said before the hang-up, so the console reads why it dropped, then that it did. */
  notice(message: string): void;
  /** Hang up as a loss, never a disconnect: whether to dial back is not decided here. */
  hangUp(): void;
}

/** One sentence per thing owed, so the console says which went unanswered. */
function deadNotice(owed: Owed, seconds: number): string {
  switch (owed) {
    case 'reply':
      return t('session.connection.deadLink', { seconds });
    case 'prompt':
      return t('session.connection.loginStalled', { seconds });
    default: {
      const never: never = owed;
      return never;
    }
  }
}

export class LinkWatch {
  private readonly timers = new Map<Owed, NodeJS.Timeout>();

  constructor(private readonly session: LinkWatchSession) {}

  /** Whether an answer is currently owed. Read by the tests and nothing else. */
  get waiting(): boolean {
    return this.timers.size > 0;
  }

  /**
   * A command reached the wire.
   *
   * The first one arms; the ones behind it do not re-arm, because the deadline
   * belongs to the *oldest* unanswered command. Re-arming per command would let
   * a character that sends every three seconds hold a dead link open for ever.
   */
  noteSent(): void {
    this.arm('reply');
  }

  /** A byte arrived. Whatever reply was owed has been answered. */
  noteReceived(): void {
    this.clear('reply');
  }

  /** The socket opened for an automated login, or a login answer reached the wire. */
  owePrompt(): void {
    this.arm('prompt');
  }

  /** A prompt or the statline arrived. */
  notePrompt(): void {
    this.clear('prompt');
  }

  /** The socket opened or closed: nothing is owed across one. */
  reset(): void {
    this.clearAll();
  }

  /** Deterministic cleanup: the timers are owned here, so they are released here. */
  dispose(): void {
    this.clearAll();
  }

  private arm(owed: Owed): void {
    if (this.timers.has(owed)) return;
    const after = tuning().reconnect.silentForMs;
    if (after <= 0) return;
    const timer = setTimeout(() => this.expire(owed, after), after);
    // A pending deadline does not owe the process another tick: a client told
    // to quit should not be held open by a connection it is about to drop.
    timer.unref();
    this.timers.set(owed, timer);
  }

  private expire(owed: Owed, after: number): void {
    // One hang-up answers everything that was owed.
    this.clearAll();
    this.session.notice(deadNotice(owed, Math.round(after / 1000)));
    this.session.hangUp();
  }

  private clear(owed: Owed): void {
    const timer = this.timers.get(owed);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(owed);
  }

  private clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
