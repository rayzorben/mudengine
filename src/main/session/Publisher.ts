/**
 * What the window is told about the session: the connection's state; the
 * decision trace (what the arbiter sent, what the rules fired, what was done
 * or refused to keep the character alive, what auto-combat engaged), through
 * the one masking point every recorded command passes; the character, with
 * `Appraisal`'s verdict and asks beside it, each of those two pushed only when
 * what it draws has changed; and the player registry, on its own, when its
 * identity moved. It reads what it reports through `Pick`s and
 * decides nothing. See `mudengine-session` › *What the window is
 * told is the publisher's*, and `parts/terminal.md` › *Nothing in it
 * redacts, and nothing may*.
 */
import { tuning } from '../app/tuning';
import type { CommandQueue } from '../automation/CommandQueue';
import type { RuleEngine } from '../automation/RuleEngine';
import type { TelnetClient } from '../net/TelnetClient';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { Appraisal } from './Appraisal';
import type { SessionSink } from './SessionSink';
import {
  MASKED_COMMAND,
  type AutomationSnapshot,
  type EngageDecision,
  type SafetyDecision,
  type SentCommand
} from '../../shared/automation';
import type { AutomationConfig } from '../../shared/config';
import type { PlayerRegistry } from '../../shared/players';
import type { ConnectionState } from '../../shared/types';
import { roomVerdictKey } from '../../shared/verdict';

/** What is told is read from: the character, its appraisal, the modules reported on, the socket. */
export interface PublisherParts {
  readonly tracker: Pick<CharacterTracker, 'current' | 'players'>;
  readonly appraisal: Pick<Appraisal, 'verdict' | 'asks'>;
  readonly queue: Pick<CommandQueue, 'snapshot'>;
  readonly rules: Pick<RuleEngine, 'firings'>;
  readonly client: Pick<TelnetClient, 'negotiated'>;
}

/** What the session that built this answers for it. */
export interface PublisherSession {
  /** The automation settings as last loaded. */
  config(): AutomationConfig;
}

/** The members of the session's sink this calls, and no more. */
export type PublisherSink = Pick<
  SessionSink,
  'character' | 'players' | 'state' | 'automation' | 'verdict' | 'asks'
>;

export class Publisher {
  private readonly tracker: PublisherParts['tracker'];
  private readonly appraisal: PublisherParts['appraisal'];
  private readonly queue: PublisherParts['queue'];
  private readonly rules: PublisherParts['rules'];
  private readonly client: PublisherParts['client'];
  private current: ConnectionState = {
    phase: 'idle',
    target: null,
    connectedAt: null,
    detail: null,
    endedBy: null,
    negotiated: {
      localEnabled: [],
      remoteEnabled: [],
      binary: false,
      suppressGoAhead: false,
      remoteEcho: false
    }
  };
  /**
   * What was done, or refused, to keep this character alive.
   *
   * Kept apart from the rule trace because a safety action is not a rule, and
   * apart from the sent log because hanging up produces no command at all —
   * which is exactly why it needs recording somewhere. "Why did the bot run?"
   * has to be answerable, and so does "why did it not hang up?".
   */
  private readonly safetyLog: SafetyDecision[] = [];
  /**
   * What auto-combat opened on, or declined to and why.
   *
   * Beside the safety trace and capped the same way, for the reason
   * `SafetyDecision` already gives: somebody who turned a feature on and saw
   * nothing happen needs to see that it *decided* not to. Auto-combat is the
   * loudest thing in the client and recorded only what it did.
   */
  private readonly engageLog: EngageDecision[] = [];
  /** What the arbiter actually sent, newest last. Bounded; this is a trace. */
  private readonly sentLog: SentCommand[] = [];
  private automationTimer: NodeJS.Timeout | null = null;
  /**
   * The next command answers a password prompt, so it must not be written down.
   *
   * A property of the *prompt*, not of who answers it: the automator and a
   * person typing are equally in need of this, and keying on the automator
   * would have left manual login credentials in the capture file. The session
   * capture records every outbound command verbatim, which is exactly what
   * makes it useful and exactly why this has to be filtered before it gets
   * there.
   */
  private awaitingPassword = false;
  /**
   * The configured password, so a command that *is* it is redacted even when
   * no prompt armed anything.
   *
   * The prompt is the right primary key — a hand-typed password answers the
   * same prompt the automator does — and it is also the weak point: a BBS
   * front-end whose password prompt the classifier has never met produces no
   * `prompt-password` block, and a manual login there would have written the
   * password down verbatim. What `connection.login` holds is known without
   * reading the prompt. Exact match only — a substring search over every
   * command is `check:secrets`' job, offline, where a false positive costs a
   * look rather than a command in the record.
   */
  private secret = '';
  /** What the last pushed appraisal drew as, so a status line that moves no figure pushes nothing. */
  private lastVerdictKey = '';
  private lastAsksKey = '';
  /** The registry last pushed: the tracker hands back the same object until a record changes. */
  private lastPlayers: PlayerRegistry | null = null;

  constructor(
    parts: PublisherParts,
    private readonly session: PublisherSession,
    private readonly sink: PublisherSink
  ) {
    this.tracker = parts.tracker;
    this.appraisal = parts.appraisal;
    this.queue = parts.queue;
    this.rules = parts.rules;
    this.client = parts.client;
  }

  /** The connection as last published. */
  get state(): ConnectionState {
    return this.current;
  }

  /** Applies a partial state update, refreshes negotiation, and publishes. */
  patch(next: Partial<Omit<ConnectionState, 'negotiated'>>): void {
    this.current = {
      ...this.current,
      ...next,
      negotiated: this.client.negotiated
    };
    this.sink.state(this.current);
  }

  /** The password `connection.login` holds, as loaded. See `secret`. */
  useSecret(password: string): void {
    this.secret = password;
  }

  /** A prompt asked for a password, so the next command is not written down. See `awaitingPassword`. */
  expectPassword(): void {
    this.awaitingPassword = true;
  }

  /**
   * What a command may be written down as.
   *
   * Everything that persists an outbound command goes through here: the session
   * capture, and the decision trace the renderer draws. The command itself
   * still reaches the socket unchanged — this is about the record, not the
   * wire.
   */
  reportable(command: string, carriesCredential = false): string {
    const isSecret =
      carriesCredential || (this.secret.length > 0 && command.trim() === this.secret);
    if (!this.awaitingPassword && !isSecret) return command;
    this.awaitingPassword = false;
    return MASKED_COMMAND;
  }

  /**
   * Records one safety decision, bounded.
   *
   * Capped like every other log here: this is a diagnostic somebody reads
   * backwards from whatever just happened, and a session that runs all evening
   * must not grow one.
   */
  noteSafety(decision: SafetyDecision): void {
    this.safetyLog.push(decision);
    if (this.safetyLog.length > tuning().session.safetyLogLimit) this.safetyLog.shift();
    this.publishAutomation();
  }

  /** One engagement decision, bounded like the safety trace. See `engageLog`. */
  noteEngagement(decision: EngageDecision): void {
    this.engageLog.push(decision);
    if (this.engageLog.length > tuning().session.safetyLogLimit) this.engageLog.shift();
  }

  recordSent(entry: SentCommand): void {
    this.sentLog.push(entry);
    if (this.sentLog.length > tuning().session.sentLogLimit) this.sentLog.shift();
    this.publishAutomation();
  }

  /** The decision trace, for a renderer that mounted mid-session. */
  get automation(): AutomationSnapshot {
    return {
      enabled: this.session.config().enabled,
      queue: this.queue.snapshot,
      // Newest first: a trace is read backwards from whatever just happened.
      sent: [...this.sentLog].reverse(),
      firings: this.rules.firings.reverse(),
      safety: [...this.safetyLog].reverse(),
      engagements: [...this.engageLog].reverse()
    };
  }

  /**
   * Publishes the trace at most every `tuning.session.automationPublishMs`.
   *
   * Leading edge, so the first change after a quiet spell is immediate — a
   * trace you have to wait a beat for is a worse trace — and trailing, so the
   * last change in a burst is not lost.
   */
  publishAutomation(): void {
    if (!this.sink.automation) return;
    if (this.automationTimer) return;
    this.sink.automation(this.automation);
    this.automationTimer = setTimeout(() => {
      this.automationTimer = null;
      this.sink.automation?.(this.automation);
    }, tuning().session.automationPublishMs);
    this.automationTimer.unref?.();
  }

  /**
   * Publishes the character, per change and deliberately *not* coalesced, and
   * the room appraised against it.
   *
   * It was coalesced once, the day the trace was (2026-08-31), and reverted
   * the same day: the renderer derives alerts from **consecutive** states — a
   * vital crossing its threshold, a name joining the roster — and collapsing
   * two states into one erased exactly the transition an alert is. The smoke
   * run caught it: the Party card said somebody was hurt and the Alerts card
   * never heard. The window's own flush (`chromeFlushMs`) is what bounds the
   * render cost, and it batches *renders* while applying every state in
   * order, which is the half a publisher on this side cannot do.
   */
  character(): void {
    this.sink.character(this.tracker.current);
    this.publishVerdict();
  }

  /**
   * The player registry, when it is not the one last pushed — the one test of
   * *the registry changed*, by identity, which every fold that writes it keeps
   * (`observe`). Asked after anything that may have moved it; it costs a
   * comparison when nothing did.
   */
  players(): void {
    const registry = this.tracker.players;
    if (registry === this.lastPlayers) return;
    this.lastPlayers = registry;
    this.sink.players(registry);
  }

  /**
   * *What can I ask the things standing here?* (`Appraisal.asks`) — pushed
   * beside the verdict, on change, and keyed the same way.
   */
  publishAsks(): void {
    const offers = this.appraisal.asks;
    const key = offers
      .map((ask) => `${ask.who}:${ask.say}:${ask.wants?.join(',') ?? ''}`)
      .join('|');
    if (key === this.lastAsksKey) return;
    this.lastAsksKey = key;
    this.sink.asks?.(offers);
  }

  /** A new dial: what the arbiter sent goes with the queue it was sent from. */
  forgetSent(): void {
    this.sentLog.length = 0;
  }

  /** A new dial: the decisions go, and a password latch left armed with them. */
  reset(): void {
    this.safetyLog.length = 0;
    this.engageLog.length = 0;
    this.awaitingPassword = false;
  }

  dispose(): void {
    if (this.automationTimer) clearTimeout(this.automationTimer);
    this.automationTimer = null;
  }

  /**
   * *Can I fight this room?* (`Appraisal.verdict`) — pushed beside the
   * character, on change. The key keeps a status line that moves no drawn
   * figure from costing a push.
   */
  private publishVerdict(): void {
    const appraisal = this.appraisal.verdict;
    const key = roomVerdictKey(appraisal);
    if (key === this.lastVerdictKey) return;
    this.lastVerdictKey = key;
    this.sink.verdict?.(appraisal);
  }
}
