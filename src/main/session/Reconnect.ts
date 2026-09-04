/**
 * Dialling back a connection that was **lost**, rather than one that was ended.
 *
 * A character standing in a dungeon does not stop being in the realm because a
 * router rebooted. On this server family the socket going is not a pause: the
 * character stays where it was, whatever is in the room stays with it, and an
 * unclean disconnect is penalised on top (docs/greatermud/combat.md). So the
 * client dialling itself back in is not a convenience — it is the difference
 * between an outage and a death.
 *
 * Three rules shape everything here.
 *
 * - **Only a loss is redialled.** Every deliberate close — the player pressing
 *   Disconnect, the low-health hang-up, switching realms from the palette,
 *   quitting — arrives at `SessionManager` as the same `close` event, and the
 *   only thing that tells them apart is that this client asked for them.
 *   `SessionManager` makes that call and this is told about the remainder;
 *   reading the phase, or worse the notice's wording, would be the same
 *   decision taken from something that is not a protocol.
 * - **And a loss the player caused is not one.** Typing your way out to the
 *   menu and then logging off the BBS closes the socket from the far end,
 *   which is indistinguishable from a dead link at the socket layer and
 *   entirely distinguishable one line above it. Redialling that would put
 *   somebody back in the realm they just left — with their password, if
 *   automatic login is on. `LoginAutomator.standDown` is the same latch that
 *   already stops the login sequence for exactly this, read rather than
 *   copied.
 * - **The ladder is per outage, and an outage ends when a connection holds.**
 *   Resetting on every socket that merely *opens* is what turns a server that
 *   accepts and immediately drops — a full BBS, a realm rebooting — into a
 *   client dialling somebody else's host as fast as TCP allows, for ever. So
 *   the wait grows across the whole outage and only a connection that lasted
 *   `settledMs` starts it over.
 *
 * The waits are `min(maxDelayMs, attempts * stepMs)`, which with the shipped
 * numbers is immediate, then 5s, 10s, and 15s for as long as it takes. Every
 * one of them is a key under `tuning.reconnect`, because a wait that suits one
 * link is wrong for another and that must not be a release.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { StandDown } from '../automation/LoginAutomator';
import type { ConnectionPhase, ConnectionState, ConnectionTarget } from '../../shared/types';
import { errorMessage } from '../../shared/values';

export interface ReconnectEvents {
  /**
   * A retry has been armed or called off.
   *
   * The rail exists to report on the characters nobody is looking at, and a
   * character waiting fifteen seconds for its next attempt looked exactly like
   * one nobody was dialling — with the tab's dial offering **Connect**,
   * because that button branches on `connected`. So there was no control
   * anywhere in the client that meant *stop trying*, while `Reconnect.cancel`'s
   * own comment claimed there was.
   */
  changed(): void;
  /**
   * Whether this character wants a lost connection dialled back.
   *
   * A callback rather than a field, following `tuning()` and `configFor`: a
   * profile is watched, so switching this off has to reach a session that is
   * already counting down rather than one started after the edit.
   */
  enabled(): boolean;
  /**
   * Dials, and reports where the attempt got to.
   *
   * Through the host rather than straight at the manager, so the session log
   * and the capture rotate per connection exactly as they do for a dial
   * somebody asked for. A reconnect that bypassed that would interleave two
   * sessions into one file, which is the one record a disagreement is settled
   * from.
   */
  dial(target: ConnectionTarget): Promise<ConnectionState>;
  notice(message: string): void;
}

/** One sentence per reason, so the console says which one answered. */
function standDownNotice(why: StandDown): string {
  // A switch of literal `t()` calls rather than a reason → key map: literal
  // calls are what `i18n-coverage.test.ts` reads out of the source, and a
  // lookup would be a dynamic one — which it fails the build for, and rightly.
  switch (why) {
    case 'left-realm':
      return t('session.reconnect.leftRealm');
    case 'login-refused':
      return t('session.reconnect.loginRefused');
  }
}

export class Reconnect {
  private timer: NodeJS.Timeout | null = null;
  /** Consecutive failures in this outage. Also the ladder's rung. */
  private attempts = 0;
  /**
   * Consecutive connections that opened and were dropped before they settled.
   *
   * Counted apart from `attempts` because the two bound different animals: an
   * outage cannot flap, and a server hanging up on a refused login cannot look
   * like an outage. See `lost`.
   */
  private flaps = 0;
  /**
   * Bumped by anything that supersedes a retry, so a dial already awaiting an
   * answer cannot schedule the next rung after being called off. A boolean
   * cannot say this: the call-off happens while the promise is in flight.
   */
  private epoch = 0;
  /**
   * Where to dial, which is the address last *dialled* rather than the one the
   * character's file names. A character dialled at a saved realm ad hoc from
   * the palette must come back to that realm; going home instead would be the
   * client moving somebody while they were not looking.
   */
  private target: ConnectionTarget | null = null;
  /** When the last connection became writable — the outage's own clock. */
  private connectedAt: number | null = null;
  private phase: ConnectionPhase = 'idle';
  /** True from the moment a dial is sent until its answer comes back. */
  private dialling = false;
  /** The last value `changed` was raised for, so a no-op raises nothing. */
  private published = false;

  constructor(private readonly events: ReconnectEvents) {}

  /** Whether an attempt is waiting on its timer, or is in flight. */
  get pending(): boolean {
    return this.timer !== null || this.dialling;
  }

  /** Republishes, and only when the answer actually moved. */
  private publish(): void {
    if (this.pending === this.published) return;
    this.published = this.pending;
    this.events.changed();
  }

  /**
   * Every connection state the session publishes.
   *
   * Read for three things it is the only source of: where to dial back to,
   * whether the connection had settled, and whether anything else has taken
   * the connection over since the timer was armed.
   */
  observe(state: ConnectionState): void {
    this.phase = state.phase;
    if (state.target !== null) this.target = state.target;
    if (state.phase === 'connected') this.connectedAt = state.connectedAt;
  }

  /**
   * The socket went and this client did not ask it to.
   *
   * `why` is the reason a redial would undo something somebody meant, or null
   * when the connection was simply lost.
   */
  lost(why: StandDown | null): void {
    this.clearTimer();
    if (!this.events.enabled()) {
      // Nothing was promised, so nothing is said. The ladder is still put down:
      // switching this on later starts from the top, not from wherever an
      // outage nobody was retrying happened to have got to.
      this.attempts = 0;
      return;
    }
    if (why !== null) {
      // Said out loud: somebody who turned this on is relying on it, and a
      // feature that declines silently is worse than one never offered.
      this.events.notice(standDownNotice(why));
      this.attempts = 0;
      return;
    }

    const established = this.connectedAt !== null;
    const held = this.connectedAt === null ? 0 : Date.now() - this.connectedAt;
    if (held >= tuning().reconnect.settledMs) {
      this.attempts = 0;
      this.flaps = 0;
    } else if (established) {
      /*
       * **A socket that opened and was then dropped is the shape that has to be
       * bounded, and it is not the one `maxAttempts` bounds.**
       *
       * An outage — the router, the host — refuses or never answers, and
       * dialling that for as long as it takes is exactly what was asked for.
       * A server that *accepts* and hangs up seconds later is a different
       * animal: a full BBS, a realm rebooting, or — the one that costs
       * something — a front end that answers a refused password with its own
       * sentence and drops the line. `login-failed` has one pattern and it is
       * GreaterMUD's wording, so on another BBS that arrives as an ordinary
       * loss with nothing to stand the ladder down, and the credentials go out
       * again every fifteen seconds for as long as the client is left running.
       *
       * So consecutive **flaps** are counted apart from attempts and bounded
       * far lower. An outage never increments this, because an outage never
       * gets a socket.
       */
      this.flaps += 1;
      if (this.flaps >= tuning().reconnect.maxFlaps) {
        this.events.notice(t('session.reconnect.keptDropping', { count: this.flaps }));
        this.attempts = 0;
        this.flaps = 0;
        this.connectedAt = null;
        this.publish();
        return;
      }
    }
    this.connectedAt = null;
    this.schedule();
  }

  /**
   * Something else has taken the connection over: an explicit dial, the
   * player pressing Disconnect, the session going away.
   *
   * Pressing Disconnect at a socket that is already closed is the one way
   * somebody can say *stop trying*, and it has nothing to close — so calling
   * this off has to be its own act rather than a side effect of the socket
   * shutting.
   */
  cancel(): void {
    this.clearTimer();
    this.epoch += 1;
    this.attempts = 0;
    this.flaps = 0;
    this.dialling = false;
    this.publish();
  }

  /** Deterministic cleanup: the timer is owned, so it is released here. */
  dispose(): void {
    this.cancel();
  }

  private schedule(): void {
    const { stepMs, maxDelayMs, maxAttempts } = tuning().reconnect;
    if (this.attempts >= maxAttempts) {
      // Named the way out rather than only the giving up: the dial is a button
      // and a palette command, and a message that stops without saying so
      // leaves somebody watching a console that has gone quiet.
      this.events.notice(t('session.reconnect.gaveUp'));
      this.attempts = 0;
      this.publish();
      return;
    }
    if (this.target === null) {
      // Nothing has ever been dialled through this session, so there is no
      // address to go back to. Unreachable from a `close`, which only follows a
      // connection; guarded because the alternative is a silent no-op.
      this.events.notice(t('session.reconnect.noTarget'));
      return;
    }

    const delay = Math.min(maxDelayMs, this.attempts * stepMs);
    this.attempts += 1;
    this.events.notice(
      delay === 0
        ? t('session.reconnect.now')
        : t('session.reconnect.waiting', {
            seconds: Math.round(delay / 1000),
            attempt: this.attempts
          })
    );
    /*
     * A timer even for the immediate attempt. `lost` is called from inside the
     * socket's own close handling, and dialling from there would re-enter the
     * client while it is still tearing the old connection down.
     */
    this.timer = setTimeout(() => this.run(), delay);
    // The process must still be able to exit while a retry is pending: a client
    // that has been told to quit does not owe anybody another dial.
    this.timer.unref();
    this.publish();
  }

  private run(): void {
    this.timer = null;
    const target = this.target;
    if (target === null) return;
    /*
     * **Read here as well as in `lost`, because that is what "read at the point
     * of use" has to mean for a ladder that runs for hours.** The callback
     * shape exists so switching the setting off reaches a session that is
     * already counting down; consulting it only when the socket dropped meant
     * the answer was fixed at the moment of the drop and the ladder then ran to
     * `maxAttempts` — 999,999 — whatever the profile said afterwards.
     */
    if (!this.events.enabled()) {
      this.attempts = 0;
      this.events.notice(t('session.reconnect.switchedOff'));
      this.publish();
      return;
    }
    /*
     * The connection was picked up by something else while this waited — the
     * player dialled, or a connect is in flight. The ladder is put down rather
     * than carried: whatever happens next is somebody else's outage.
     */
    if (this.phase !== 'closed' && this.phase !== 'error') {
      this.attempts = 0;
      return;
    }

    const mine = this.epoch;
    this.dialling = true;
    this.publish();
    void this.events.dial(target).then(
      (state) => {
        this.dialling = false;
        if (mine !== this.epoch) {
          this.publish();
          return;
        }
        /*
         * A socket opened. Whether it *holds* is not decided here — the next
         * `lost` says, and `settledMs` is what makes the difference between an
         * outage that ended and one that is still going.
         */
        if (state.phase === 'connected') {
          this.publish();
          return;
        }
        this.schedule();
      },
      (error: unknown) => {
        this.dialling = false;
        if (mine !== this.epoch) {
          this.publish();
          return;
        }
        // Never swallowed: a dial that threw rather than reporting a refusal is
        // a fault in the client, and the retry that follows would otherwise
        // hide it for as long as the outage lasts.
        this.events.notice(t('session.reconnect.dialFailed', { detail: errorMessage(error) }));
        this.schedule();
      }
    );
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
