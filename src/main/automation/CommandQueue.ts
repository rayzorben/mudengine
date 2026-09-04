/**
 * The arbiter: the single writer for everything the client sends.
 *
 * docs/legacy-assessment.md §6 argues that inbound is a broadcast and outbound
 * is one owner. This is that owner. Nothing else may write to the socket on
 * automation's behalf.
 *
 * ## Why the flow control looks like this
 *
 * Measured against the live server (§6.2, now answered): commands are accepted
 * up to roughly twenty in flight and **silently discarded** past that. Twenty
 * sent, twenty answered; twenty-five sent, *two* answered; thirty sent, none —
 * with the connection still up and no complaint of any kind. There is no
 * `You are typing too quickly` at these rates and no disconnect. The loss is
 * undetectable from the client.
 *
 * So pacing is not a cosmetic nicety and a fixed sleep is not good enough. The
 * protocol already provides an acknowledgement: every command produces a status
 * line. This queue uses that as credit — at most `window` commands outstanding,
 * released as prompts come back — which is flow control derived from what the
 * server actually does rather than from a guessed interval.
 *
 * ## Why it is a queue and not an event handler
 *
 * A sent command cannot be recalled. Holding intents client-side is the only
 * place a decision stays revisable: if the situation changes, `cancel` still
 * works on anything not yet on the wire.
 */
import { PRIORITY, type Priority, type QueueSnapshot } from '../../shared/automation';
import type { AutomationConfig } from '../../shared/config';
import { tuning } from '../app/tuning';

export { PRIORITY, type Priority, type QueueSnapshot };

export interface Intent {
  command: string;
  priority: Priority;
  /**
   * Idempotent intents collapse while queued: two requests to refresh the stat
   * sheet are one refresh. Coalescing is by *intent*, never by command text —
   * a second `n` is a different move, which is the bug that forced
   * `megamind-client` to exempt every direction from its de-duplicator.
   */
  coalesceKey?: string;
  /** Dropped rather than sent late. */
  expiresAt?: number;
  /** Free-text note, for the decision trace. */
  reason?: string;
  /**
   * The command has just been written to the socket.
   *
   * For a proposer whose own deadline measures the **server's** silence. The
   * time an intent spends in here is the *client's* — the player holding the
   * floor with a half-typed line, the acknowledgement window closed — and
   * charging it to the server is how a walk reported `nothing came back after
   * se` for a step the capture shows was never sent at all
   * (`logs/2026-09-02_13-29-52_festus.mudcap.jsonl`: no `se` anywhere between
   * the player's `bank` and the next automated cast). That sentence sends
   * whoever reads it to the wrong end of the wire.
   *
   * Not a completion callback: nothing here knows whether the command worked,
   * only that it was written. An intent that is cancelled or expires never
   * calls it, so a caller that arms a deadline from it needs a second one for
   * the wait to reach the wire at all.
   */
  onSent?: () => void;
}

interface Queued extends Intent {
  seq: number;
  enqueuedAt: number;
}

export interface QueueEvents {
  /** Send this on the wire. */
  send(command: string, intent: Queued): void;
  /** Something worth telling the player. */
  notice?(message: string): void;
  /**
   * Commit whatever half-typed line the player has on the wire, so an
   * emergency can go out clean. See the emergency exception in `drain`.
   */
  clearTypedLine?(): void;
}

export class CommandQueue {
  private readonly pending: Queued[] = [];
  private inFlight = 0;
  private seq = 0;
  private lastSentAt = 0;
  /**
   * While the player has a half-typed line, automation stands down.
   *
   * A state, not a timer: the server buffers our bytes into the same input
   * line as the player's in-flight keystrokes, so anything sent mid-line is
   * glued onto what they have typed so far — corrupting both. The hold is
   * released by the state that makes sending safe again (the line committed
   * or erased), not by a guess about how fast people type.
   */
  private typingHeld = false;
  /** When the hold lapses as abandoned: the last keystroke plus the ceiling. */
  private typingHeldUntil = 0;
  /** When the current hold began, for crediting held time back to expiries. */
  private heldAt = 0;
  /** Re-entrancy latch: `clearTypedLine` re-enters via `noteTyping`. */
  private pumping = false;
  private timer: NodeJS.Timeout | null = null;
  /** When the armed timer fires, so a sooner deadline can replace it. */
  private timerAt = 0;
  /** When each outstanding command was sent, oldest first. */
  private outstanding: number[] = [];

  constructor(
    private config: AutomationConfig,
    private readonly events: QueueEvents
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
  }

  get snapshot(): QueueSnapshot {
    return {
      depth: this.pending.length,
      inFlight: this.inFlight,
      suppressed: this.isSuppressed(),
      pending: this.pending.map((intent) => ({
        command: intent.command,
        priority: intent.priority,
        ...(intent.reason === undefined ? {} : { reason: intent.reason })
      }))
    };
  }

  /**
   * Offers an intent. Returns false when it was dropped — disabled, a
   * duplicate of something already queued, or past its expiry.
   */
  enqueue(intent: Intent): boolean {
    if (!this.config.enabled && intent.priority !== 'user') return false;
    if (intent.expiresAt !== undefined && intent.expiresAt <= Date.now()) return false;

    if (intent.coalesceKey !== undefined) {
      const existing = this.pending.find((queued) => queued.coalesceKey === intent.coalesceKey);
      if (existing) {
        // Keep the higher priority; the request itself is the same request.
        if (PRIORITY[intent.priority] > PRIORITY[existing.priority]) {
          existing.priority = intent.priority;
        }
        /*
         * And the later expiry. A re-proposal is the proposer saying the
         * intent still holds, and keeping the original deadline let a
         * standing one die of old age while the player's typing held the
         * queue — the reason auto-combat sat silent through a dozen rounds.
         */
        if (existing.expiresAt !== undefined) {
          if (intent.expiresAt === undefined) delete existing.expiresAt;
          else existing.expiresAt = Math.max(existing.expiresAt, intent.expiresAt);
        }
        return false;
      }
    }

    this.seq += 1;
    this.pending.push({ ...intent, seq: this.seq, enqueuedAt: Date.now() });
    this.pump();
    return true;
  }

  /**
   * Drops queued intents matching a predicate.
   *
   * The reason the queue exists: a decision made two seconds ago may no longer
   * be the right one, and anything not yet on the wire can still be taken back.
   */
  cancel(match: (intent: Intent) => boolean): number {
    let removed = 0;
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (!match(this.pending[i]!)) continue;
      this.pending.splice(i, 1);
      removed += 1;
    }
    return removed;
  }

  clear(): void {
    this.pending.length = 0;
    this.inFlight = 0;
    this.outstanding = [];
    this.typingHeld = false;
  }

  /**
   * Whether the player has a half-typed line on the wire.
   *
   * `true` on every keystroke that leaves one — automation stands down until
   * told otherwise, however long the player thinks mid-word, because the
   * server would glue anything sent now onto their partial input. `false` the
   * moment the line is committed or erased to nothing, and **immediately** is
   * the point: a person's Enter is what "the command comes after" means, and
   * the timed grace this replaces both let a mid-line pause through (the
   * corruption) and made every committed command cost automation a further
   * silent second and a half (the latency the player read as "it is not
   * attacking").
   */
  noteTyping(partial: boolean): void {
    if (partial) {
      if (!this.typingHeld) this.heldAt = Date.now();
      this.typingHeld = true;
      this.typingHeldUntil = Date.now() + tuning().queue.abandonedLineMs;
      return;
    }
    if (!this.typingHeld) return;
    this.typingHeld = false;
    /*
     * The expiry clock does not count time the player held the floor: a
     * proposal made just before they started typing must be exactly as fresh
     * at their Enter as it was then, or "the command comes after" quietly
     * becomes "the command died while you typed". An *abandoned* line gets no
     * such credit — its lapse goes through `blockedFor`, not here, and what
     * expired during it stays expired, because nobody is about to press the
     * Enter the extension exists for.
     */
    const heldFor = Date.now() - this.heldAt;
    if (heldFor > 0) {
      for (const intent of this.pending) {
        if (intent.expiresAt !== undefined) intent.expiresAt += heldFor;
      }
    }
    this.pump();
  }

  /**
   * A prompt came back: one outstanding command has been acknowledged.
   *
   * This is the credit that releases the next send. Without it the queue would
   * be pacing on a guess.
   */
  notePrompt(): void {
    if (this.inFlight > 0) {
      this.inFlight -= 1;
      this.outstanding.shift();
    }
    this.pump();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.clear();
  }

  /** Sends what it can, and schedules itself for whatever it cannot yet. */
  private pump(): void {
    /*
     * `clearTypedLine` below runs back through `SessionManager.send`, whose
     * bookkeeping calls `noteTyping(false)`, which pumps. Re-entering would
     * send twice off one decision; deferring the inner call loses nothing,
     * because the outer one is about to finish the same work.
     */
    if (this.pumping) {
      this.schedule(10);
      return;
    }
    this.pumping = true;
    try {
      this.drain();
    } finally {
      this.pumping = false;
    }
  }

  private drain(): void {
    /*
     * An abandoned line lapses before anything else is decided. Expiry is
     * frozen while the hold stands, so resolving the lapse *after* `expire`
     * would ship every intent the freeze kept alive on the first drain past
     * the ceiling — stale by up to the whole hold, with nobody at the keys.
     */
    if (this.typingHeld && Date.now() >= this.typingHeldUntil) this.typingHeld = false;
    this.expire();
    this.reclaimStalled();

    if (this.pending.length === 0) return;

    const now = Date.now();
    const wait = this.blockedFor(now);
    if (wait > 0) {
      this.schedule(wait);
      return;
    }

    // Highest priority first, then oldest — so a burst of equal-priority
    // intents keeps the order they were decided in.
    this.pending.sort((a, b) => PRIORITY[b.priority] - PRIORITY[a.priority] || a.seq - b.seq);

    const next = this.pending.shift()!;
    /*
     * The one exception to the typing hold, and it is documented as one: an
     * emergency — an escape — outranks even the player. It cannot simply be
     * written through a half-typed line, though: the server would read
     * `ln`, say it out loud, and the escape would never run. So the
     * player's partial line is committed first — their half-command executes
     * as whatever it was, which is the price — and the emergency goes out
     * clean behind it. Any future band that must also break the hold goes
     * through this same gate, not around it.
     */
    if (this.typingHeld && next.priority === 'emergency') {
      this.events.clearTypedLine?.();
      this.typingHeld = false;
    }
    this.inFlight += 1;
    this.outstanding.push(now);
    this.lastSentAt = now;
    this.events.send(next.command, next);
    // After the write, because that is the fact being reported: the bytes are
    // on the socket and whatever answers now is answering this.
    next.onSent?.();

    if (this.pending.length > 0) this.schedule(this.config.pacing.minGapMs);
  }

  /** Milliseconds until a send is allowed, or 0 if one is allowed now. */
  private blockedFor(now: number): number {
    if (this.typingHeld) {
      const lapse = this.typingHeldUntil - now;
      // An emergency does not wait on the player's typing — see `drain`.
      const emergency = this.pending.some((intent) => intent.priority === 'emergency');
      // Checked at a bounded cadence rather than sleeping the whole ceiling:
      // the release normally arrives as an event (`noteTyping(false)`), and
      // this timer only exists to notice an abandoned line.
      if (lapse > 0 && !emergency) return Math.min(lapse, 1000);
      if (lapse <= 0) this.typingHeld = false;
    }

    if (this.inFlight >= this.config.pacing.window) {
      // Waiting on an acknowledgement. The stall reclaim below is what stops
      // this becoming a deadlock when a command produces no prompt.
      return this.config.pacing.ackTimeoutMs;
    }

    /*
     * The gap exists to stop commands stacking up on a server that is still
     * working. With nothing outstanding there is nothing to stack: the server
     * is idle and waiting, which is exactly the request/response shape of a
     * login. Waiting there is pure latency.
     */
    if (this.inFlight === 0) return 0;

    const sinceLast = now - this.lastSentAt;
    return sinceLast >= this.config.pacing.minGapMs ? 0 : this.config.pacing.minGapMs - sinceLast;
  }

  private isSuppressed(): boolean {
    return this.typingHeld && this.typingHeldUntil > Date.now();
  }

  /**
   * Releases credit for commands that never produced a prompt.
   *
   * Not everything answers with a status line — a menu response, a command the
   * game ignores. Without this the window would close permanently the first
   * time one went unanswered.
   */
  private reclaimStalled(): void {
    const deadline = Date.now() - this.config.pacing.ackTimeoutMs;
    while (this.outstanding.length > 0 && this.outstanding[0]! < deadline) {
      this.outstanding.shift();
      if (this.inFlight > 0) this.inFlight -= 1;
    }
  }

  private expire(): void {
    /*
     * Not while the player holds the floor with a half-typed line. The hold
     * is their own pause, and "the command comes after" means the decision
     * made during it survives to the Enter — the alternative was proposals
     * quietly dying of old age behind somebody watching a fight, which read
     * as "it is not attacking". Staleness while held is bounded by the
     * abandoned-line ceiling, and an attack on something that died meanwhile
     * is answered by `Your command had no effect.`, which the tracker
     * already reads and self-corrects from.
     */
    if (this.typingHeld) return;
    const now = Date.now();
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const intent = this.pending[i]!;
      if (intent.expiresAt !== undefined && intent.expiresAt <= now) this.pending.splice(i, 1);
    }
  }

  private schedule(delay: number): void {
    const wait = Math.max(10, delay);
    const at = Date.now() + wait;
    // Keep whichever deadline is sooner. A timer parked on the 3s stall
    // window must not swallow the 10ms retry a released hold just asked for.
    if (this.timer !== null && this.timerAt <= at) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, wait);
    this.timer.unref?.();
  }
}
