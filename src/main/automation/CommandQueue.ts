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
import {
  MASKED_COMMAND,
  PRIORITY,
  type Priority,
  type QueueSnapshot
} from '../../shared/automation';
import type { AutomationConfig } from '../../shared/config';
import { tuning } from '../app/tuning';

export { PRIORITY, type Priority, type QueueSnapshot };

/**
 * Why `offer` took nothing, gate by gate in the order it asks: a screen that
 * is not a command prompt, no socket, automation switched off, a deadline
 * already past, a word the realm does not have. A proposer that must say why
 * nothing went out reads this rather than guessing (todo 767).
 */
export type QueueRefusal = 'held' | 'offline' | 'switched-off' | 'expired' | 'unavailable';

/** What became of an intent offered: queued, folded into the same intent already waiting, or refused. */
export type Offered = 'queued' | 'joined' | QueueRefusal;

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
  /**
   * Whether this is still worth sending, asked immediately before the send.
   *
   * **Everything else about an intent is decided once, at the moment it is
   * proposed, and the queue may hold it for a round.** That is usually right —
   * the arbiter exists so a decision can wait its turn — but a few commands
   * have a precondition the *server* enforces and that a single round is
   * enough to falsify. A bare `search` is the one this was written for
   * (todo 13, 2026-09-13): proposed on arriving in a room with nothing
   * fighting, held behind the `aa` auto-combat proposed from the same status
   * line, and sent into the fight that attack had just started —
   * `You may not search while attacking!`, twice in one capture.
   *
   * Nothing is retried on the strength of this: a false answer **drops** the
   * intent, and the proposer re-derives from the next status line, which is
   * what makes *after the fight* fall out for free. A proposer holding a
   * memory of having asked should therefore count in `onSent` rather than at
   * the proposal, or the one it never sent spends its budget.
   *
   * Pure, and asked about *now*: it reads live state, never the state the
   * proposal was made against.
   */
  stillWanted?: () => boolean;
  /** Free-text note, for the decision trace. */
  reason?: string;
  /**
   * This command carries a credential and must never be written down.
   *
   * On the intent rather than on a session latch because the latch is armed
   * when the answer is *decided* and read when the next command is *reported*,
   * and the queue is free to hold the two apart — the typing hold does exactly
   * that, and at a login screen the player typing is the ordinary case. What
   * was armed for the password was then spent masking the player's own line,
   * and the password went down verbatim behind it. A flag on the intent
   * travels with the command it is about, so nothing can come between them.
   *
   * `Publisher.reportable` is still the one choke point; this only tells
   * it the answer without asking it to guess.
   */
  secret?: boolean;
  /**
   * The command keeps the **connection** alive rather than acting for the
   * character, so it goes out with automation switched off as well — at its
   * own band, unlike a login answer, which rides at `user`. The keep-alive is
   * the one: without it a switched-off character sends nothing, and a link
   * that dies then is noticed by nobody (`LinkWatch` only times a command that
   * went out). Measured 2026-09-18: 23 minutes on a dead socket.
   */
  keepsLink?: boolean;
  /**
   * The player's own line, paced rather than written at once: one command of
   * a talk-box line that stands for several (todo 04). Sent through
   * `SessionManager.send`, the path a keystroke takes, so it is observed and
   * recorded as the player's; queued because the realm queues fifteen, warns
   * to twenty and drops the rest (`GMUDInGameState.cs:37`), and automation
   * spends from the same fifteen.
   */
  typed?: boolean;
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
  /**
   * The earliest this may go out, for an intent put back after the server
   * threw it away (`resendLast`). Absent on everything else.
   *
   * `drain` **skips** an intent that is not due rather than waiting on it: an
   * escape must never queue behind a walk step that is serving out a
   * confusion delay, and blocking the whole queue on the head is exactly how
   * that would happen.
   */
  notBefore?: number;
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
  /**
   * Whether this realm has no such word, so the command must not be sent.
   *
   * Asked of **automation only**, and asked here because this is the one
   * funnel every automated command goes through — the same reason `send`
   * files the command for the tracker and the classifier here rather than at
   * each proposer.
   *
   * It exists because an unrecognised command on this server family is not
   * refused quietly: it is *said out loud in the room*, to everybody standing
   * there. So a probe on a clock is not a wasted command, it is a broadcast
   * per ask for the evening. `SessionManager` owns the answer, because it is
   * the one that knows which lineage the server belongs to and which words it
   * has already heard the realm speak aloud.
   *
   * A **person** typing one is never refused. They may be finding out, and
   * the player outranks automation everywhere else in this class too.
   *
   * Saying so is the answerer's job, not this one's: it knows what it knows
   * and can say it once per word, where a line per dropped intent would be a
   * line per probe.
   */
  unavailable?(command: string): boolean;
  /**
   * Whether there is a socket to write to. False refuses every intent and
   * sends nothing, the player's included.
   *
   * `TelnetClient.send` drops a write to a closed socket without a word, and
   * `send` above had already filed the command for the capture, the trace and
   * the dead-link clock by then — so a keep-alive proposed into a closed
   * session was recorded as sent and reported unanswered every 45 seconds for
   * seven hours (2026-09-18). A command that cannot reach the wire is not one
   * this client sent.
   */
  connected?(): boolean;
}

export class CommandQueue {
  private readonly pending: Queued[] = [];
  private inFlight = 0;
  private seq = 0;
  private lastSentAt = 0;
  /**
   * What has been written to the socket lately, oldest first, so an intent can
   * be put back when the server says it threw that one away.
   *
   * A **list** rather than the last one: the window allows several commands in
   * flight, and the entry probe alone puts seven on the wire in a breath — so
   * the command a fumble is about is routinely two or three sends back. Bounded
   * by the acknowledgement timeout on the way in, since anything older than
   * that has been answered or written off.
   *
   * Only what this queue sent: the player's own typing never comes through
   * this class, so `resendLast` cannot replay a keystroke. A talk-box line of
   * several (`Intent.typed`) does, and is put back like any other.
   */
  private recentlySent: Array<{ intent: Queued; at: number }> = [];
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
  /**
   * Why the character is not at a command prompt at all, or null.
   *
   * Distinct from `typingHeld`, and absolute where that one is not. A
   * half-typed line means the server would *glue* what is sent onto it, which
   * an emergency is allowed to answer by committing the line first. A telnet
   * field screen means there is no command line to send to: every byte is a
   * keystroke in whichever form field has focus, and the character's family
   * name is the field that has it on the way in. So nothing is exempt — not an
   * emergency, not the player's own toolbar — and what is already queued is
   * dropped rather than held, because an intent raised for a character
   * standing in a room is not an intent about a form.
   *
   * The server gives the client nothing to pace on here: `train stats` prints
   * no prompt (`TrainCommand.cs:72`), so `reclaimStalled` below hands the
   * window back after the acknowledgement timeout and the queue sends into the
   * form for as long as it is up. That is the bug this exists for.
   */
  private held: string | null = null;

  constructor(
    private config: AutomationConfig,
    private readonly events: QueueEvents
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
  }

  /**
   * Stands the whole queue down and empties it. Returns false if already held.
   *
   * Idempotent on purpose: the screen is armed from two independent facts —
   * the command the player typed and the screen itself arriving — and the
   * second must not re-announce what the first already said.
   */
  hold(reason: string): boolean {
    if (this.held !== null) return false;
    // Emptied first: `clear` is also what lifts a hold, so the order matters.
    this.clear();
    this.held = reason;
    return true;
  }

  /** Back at a prompt. Returns false if nothing was held. */
  release(): boolean {
    if (this.held === null) return false;
    this.held = null;
    this.pump();
    return true;
  }

  /** Why nothing may be sent, or null. */
  get holding(): string | null {
    return this.held;
  }

  get snapshot(): QueueSnapshot {
    return {
      depth: this.pending.length,
      inFlight: this.inFlight,
      suppressed: this.isSuppressed(),
      pending: this.pending.map((intent) => ({
        /*
         * Masked here as well as in the record.
         *
         * This snapshot is the decision trace the Automation card and the
         * status rail draw, republished on every block — so a login answer
         * waiting out the typing hold or the pacing gap put the filled
         * password on screen, in full, until it drained. `reportable` is still
         * the one choke point for anything *persisted*; this is the same fact
         * reaching a different surface.
         */
        command: intent.secret === true ? MASKED_COMMAND : intent.command,
        priority: intent.priority,
        ...(intent.reason === undefined ? {} : { reason: intent.reason }),
        ...(intent.typed === true ? { typed: true } : {})
      }))
    };
  }

  /**
   * Offers an intent. Returns false when it was dropped — disabled, a
   * duplicate of something already queued, or past its expiry. `offer` says
   * which.
   */
  enqueue(intent: Intent): boolean {
    return this.offer(intent) === 'queued';
  }

  /** Offers an intent, and says what became of it. See `Offered`. */
  offer(intent: Intent): Offered {
    // Ahead of the `user` exemption every other gate here makes: a person's
    // toolbar press is a command for the realm too, and the realm is not what
    // is listening.
    if (this.held !== null) return 'held';
    if (this.events.connected?.() === false) return 'offline';
    if (!this.config.enabled && intent.priority !== 'user' && intent.keepsLink !== true) {
      return 'switched-off';
    }
    if (intent.expiresAt !== undefined && intent.expiresAt <= Date.now()) return 'expired';
    /*
     * A word this realm does not have. Refused rather than sent, and said out
     * loud by whoever answered — a safety feature that silently declines is
     * worse than one that was never offered, and this one declines by *not
     * broadcasting a command into a room full of people*.
     */
    if (intent.priority !== 'user' && this.events.unavailable?.(intent.command) === true) {
      return 'unavailable';
    }

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
        return 'joined';
      }
    }

    this.seq += 1;
    this.pending.push({ ...intent, seq: this.seq, enqueuedAt: Date.now() });
    this.pump();
    return 'queued';
  }

  /**
   * Puts back the command the server has just said it threw away.
   *
   * `You fumble in confusion!` is the server discarding whatever was sent
   * *before it looked at it* — `ActionFigure.CheckConfusion` runs at the top of
   * `Player.HandleCommand` and `return`s on a hit — so the decision that
   * produced the command is still the right decision and nothing acted on it.
   * Reported as todo 02: a loop's `e` was fumbled, nothing re-sent it, and the
   * walk waited out its eight-second deadline and gave up. Confusion lasts
   * long enough to eat several in a row.
   *
   * **At the head, by keeping its original `seq`.** It was enqueued before
   * everything now pending, so the ordering the queue already has puts it
   * first within its band — no new mechanism, and an escape still outranks it.
   *
   * **After the delay the server itself imposes.** A fumble sets a 1,000ms
   * `DelayCommand` on the character (`ActionFigure.CheckConfusion`), so the
   * next status line arrives *inside* it and a resend on that line would be
   * sent into a wait. `tuning.queue.fumbleRetryMs` is the server's own
   * figure, which is a reading rather than a guess — and erring long costs
   * latency where erring short costs the command again.
   *
   * **Only what this queue sent, and only what the server named.** The caller
   * passes the command the status line echoed; a mismatch means the fumbled
   * command was not the one in flight — the player typed one — and nothing is
   * put back. The player's typing never comes through this class, which is
   * the other half of *not manual user commands*; a talk-box line of several
   * does (`Intent.typed`), and a fumbled one is put back as a walk's step is,
   * or the rest of the line walks from the wrong room.
   *
   * Returns whether anything was put back, so the caller can say so.
   */
  resendLast(command: string | null): boolean {
    if (command === null) return false;
    const now = Date.now();
    // Anything this old has been answered or written off, so it cannot be what
    // the server has just thrown away.
    const oldest = now - this.config.pacing.ackTimeoutMs;
    this.recentlySent = this.recentlySent.filter((entry) => entry.at >= oldest);
    const wanted = command.trim().toLowerCase();
    /*
     * The newest match. Two sends of one command are the same bytes with the
     * same intent behind them, so which of the pair the server threw away
     * changes nothing about what goes back.
     */
    const at = this.recentlySent
      .map((entry) => entry.intent.command.trim().toLowerCase())
      .lastIndexOf(wanted);
    if (at === -1) return false;
    // Taken out, so one fumble puts one command back. The resend joins the
    // list when it is sent, which is what makes a confusion that eats four in
    // a row four resends rather than a loop over one intent.
    const last = this.recentlySent.splice(at, 1)[0]!.intent;
    const notBefore = now + tuning().queue.fumbleRetryMs;
    /*
     * Its own deadline is moved with it. An intent that expires while the
     * character is confused is one the proposer would rather drop — the
     * expiry is *worthless if it arrives late* — but an expiry measured
     * against a send that never ran would drop a command that was never
     * given its chance.
     */
    const expiresAt =
      last.expiresAt === undefined
        ? undefined
        : Math.max(last.expiresAt, notBefore + (last.expiresAt - last.enqueuedAt));
    this.pending.push({ ...last, notBefore, ...(expiresAt === undefined ? {} : { expiresAt }) });
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

  /** Whether anything matching a predicate is still waiting to go out. */
  queued(match: (intent: Intent) => boolean): boolean {
    return this.pending.some(match);
  }

  /**
   * Everything queued, gone.
   *
   * **And any hold with it.** Every caller outside this class is a session
   * boundary — the socket closing, a new connection, the character walking out
   * to the menu — and a hold is about the character who was standing there. A
   * hold that outlived one of those would stand automation down for the rest
   * of the process with nothing on screen saying why.
   */
  clear(): void {
    this.held = null;
    this.pending.length = 0;
    this.inFlight = 0;
    this.outstanding = [];
    this.typingHeld = false;
    // Nothing is in flight any more, so there is nothing a fumble could be
    // about — and replaying a command from before a disconnect is the one
    // thing `resendLast` must never do.
    this.recentlySent = [];
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
    // Nothing reaches a form field. `enqueue` already refuses, so `pending` is
    // empty; this is the invariant stated where a send would happen, so a
    // future path that puts something back cannot route around it.
    if (this.held !== null) return;
    // Nor a closed socket. `enqueue` refuses too; what was queued before the
    // close is dropped by `SessionManager`'s own `clear()` there.
    if (this.events.connected?.() === false) return;
    /*
     * An abandoned line lapses before anything else is decided. Expiry is
     * frozen while the hold stands, so resolving the lapse *after* `expire`
     * would ship every intent the freeze kept alive on the first drain past
     * the ceiling — stale by up to the whole hold, with nobody at the keys.
     */
    if (this.typingHeld && Date.now() >= this.typingHeldUntil) this.typingHeld = false;
    this.expire();
    this.dropUnwanted();
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

    /*
     * The first intent that is *due*. Only a resend after a fumble is ever not
     * due (`resendLast`), and it is skipped rather than waited on: the server
     * holds the character for a second after throwing a command away, and an
     * escape queued behind that second would be an escape that arrives after
     * the fight. A wake is scheduled for the soonest one held back so nothing
     * sits in the queue waiting for another intent to arrive and drain it.
     */
    const at = this.pending.findIndex((intent) => (intent.notBefore ?? 0) <= now);
    if (at === -1) {
      const soonest = Math.min(...this.pending.map((intent) => intent.notBefore ?? 0));
      this.schedule(Math.max(1, soonest - now));
      return;
    }
    const next = this.pending.splice(at, 1)[0]!;
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
    /*
     * Trimmed **on the way in**, which is what makes the bound real: the only
     * other trim is inside `resendLast`, and that runs on a fumble — an event
     * that fires while a character is confused and approximately never
     * otherwise. Left to it, this grew one entry per automated command for the
     * life of the session (~29,000 over an unattended night), each holding the
     * `onSent` closure a walk step captures, so every leg walked all night
     * stayed reachable. The reviewer's find, 2026-09-06.
     */
    this.recentlySent = this.recentlySent.filter(
      (entry) => entry.at >= now - this.config.pacing.ackTimeoutMs
    );
    this.recentlySent.push({ intent: next, at: now });
    this.events.send(next.command, next);
    // After the write, because that is the fact being reported: the bytes are
    // on the socket and whatever answers now is answering this.
    next.onSent?.();

    /*
     * Anything left is either due — and waits `minGapMs` — or held back, and
     * that wake is the `at === -1` branch above: this schedule brings the
     * drain round, that one re-schedules for the remainder. A second wake
     * computed here would be a filter per drain feeding a branch that cannot
     * be reached, since `next` is due by construction and therefore never one
     * of the held.
     */
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
    if (this.held !== null) return true;
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

  /**
   * Anything whose precondition has stopped being true since it was proposed.
   *
   * Beside `expire` because it is the same act — taking an intent out of the
   * queue rather than sending it — and deliberately **not** subject to the
   * same typing hold. Expiry pauses during the player's pause so that a
   * decision made before it survives to the Enter; this is the opposite case,
   * where the world has moved on and the command would now be refused by the
   * server. Waiting out somebody's half-typed line does not make a fight stop
   * being a fight.
   *
   * Silent: the proposer knows its own reason and says it where it says
   * everything else, and a line per dropped probe is the noise `unavailable`
   * gives the same argument for.
   */
  private dropUnwanted(): void {
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (this.pending[i]!.stillWanted?.() === false) this.pending.splice(i, 1);
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
