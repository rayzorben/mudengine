/**
 * The last-ditch escape below `retreat` (todo 813): the realm's own teleport,
 * the literal `safety.fleeGoto.command` the realm's `server.yaml` states (a
 * character may state its own), sent mid-fight in the emergency band once the
 * walked escape has had its word. The fight is broken off on the sent clock
 * until the answer (`Travel.teleportSent`): a new room is the escape landing,
 * `Your command had no effect.` or `sys-refused` (a bad room) echoed against
 * it a refusal kept for the connection (the clock released), a death or
 * leaving the realm drops it, silence gives it up.
 * Never on the ground. See `mudengine-automation` › `parts/safety.md`.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { CommandQueue } from '../automation/CommandQueue';
import type { SessionModule } from '../automation/Module';
import type { CharacterTracker } from '../parse/CharacterTracker';
import { EchoSince } from '../parse/echo';
import type { Grounded } from './Grounded';
import type { Publisher } from './Publisher';
import type { Travel } from './Travel';
import { healthFraction, percentText } from '../../shared/automation';
import type { Block, BlockType } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import { landed } from '../../shared/walk';

/** The action every decision here is traced under. */
const ACTION = 'teleport';

/** What the realm answers a teleport it will not run. */
const REFUSALS: ReadonlySet<BlockType> = new Set([
  'command-no-effect',
  'sys-refused',
  'command-refused'
]);
/**
 * The refusals of the command itself, true for the whole connection: not a
 * sysop, or a room the realm does not have (`sys-refused`, todo 766).
 * `command-refused` is the moment's (mortally wounded), so it is not kept.
 */
const KEPT: ReadonlySet<BlockType> = new Set(['command-no-effect', 'sys-refused']);

/** What the teleport reads, and the escape it leaves the character through. */
export interface FleeGotoParts {
  readonly tracker: Pick<CharacterTracker, 'current' | 'pendingMoves'>;
  readonly queue: Pick<CommandQueue, 'enqueue'>;
  readonly travel: Pick<
    Travel,
    'escapeUnanswered' | 'teleportSent' | 'teleportRefused' | 'teleportLanded'
  >;
  readonly publisher: Pick<Publisher, 'noteSafety'>;
  readonly grounded: Pick<Grounded, 'down'>;
}

/** What the session that built this answers for it. */
export interface FleeGotoSession {
  /** The automation settings as last loaded. */
  config(): AutomationConfig;
  notice(message: string): void;
}

export class FleeGoto implements SessionModule {
  private readonly tracker: FleeGotoParts['tracker'];
  private readonly queue: FleeGotoParts['queue'];
  private readonly travel: FleeGotoParts['travel'];
  private readonly publisher: FleeGotoParts['publisher'];
  private readonly grounded: FleeGotoParts['grounded'];
  /**
   * The teleport whose answer has not come: the command, why, the room it was
   * sent from, whether the byte has left, and by when. Only a block after the
   * send is its answer: a refusal before it answers something else.
   */
  private awaiting: {
    command: string;
    why: string;
    from: CharacterState['room'];
    /** When the fight was broken off for it: the sent clock it started. */
    at: number;
    sent: boolean;
    deadline: number;
    /** The echoes since the send, which pair a refusal with this command. */
    echo: EchoSince;
  } | null = null;
  /** The retry floor, the retreat's own `cooldownMs`. */
  private lastAsked = 0;
  /**
   * The command the realm refused this connection. Not a sysop stays not a
   * sysop and a room the realm lacks stays missing, so it is said once and
   * not sent again until a reconnect or a different command.
   */
  private refused: string | null = null;
  /** A refusal already said this fight (no command stated), so it is said once. */
  private saidThisFight = false;

  constructor(
    parts: FleeGotoParts,
    private readonly session: FleeGotoSession
  ) {
    this.tracker = parts.tracker;
    this.queue = parts.queue;
    this.travel = parts.travel;
    this.publisher = parts.publisher;
    this.grounded = parts.grounded;
  }

  /** On connect and on leaving the realm: a teleport still unanswered is dropped out loud. */
  reset(): void {
    if (this.awaiting !== null) {
      this.session.notice(t('session.safety.teleportDropped', { command: this.awaiting.command }));
      this.decided(this.awaiting.why, false, t('session.safety.teleportDroppedReason'));
      this.travel.teleportRefused(this.awaiting.at);
    }
    this.awaiting = null;
    this.lastAsked = 0;
    this.refused = null;
    this.saidThisFight = false;
  }

  /**
   * Below its floor in a fight, after the walked escape has had its word.
   * Called after `Travel.considerEscape` on the same line, so an escape it
   * just proposed is already unanswered here, and the teleport waits for it.
   */
  consider(state: CharacterState): void {
    const automation = this.session.config();
    const setting = automation.safety.fleeGoto;
    if (!setting.enabled || !automation.enabled || state.phase !== 'in-game') return;
    const now = Date.now();
    if (this.awaiting !== null) {
      this.giveUpIfLate(now);
      return;
    }
    if (!state.inCombat && state.combat.attackers.length === 0) {
      this.saidThisFight = false;
      return;
    }
    // The session's gate returns before this on the line path; the PvP path
    // and a test do not, and nothing is ever sent from the ground.
    if (this.grounded.down || state.mortallyWounded) return;
    const fraction = healthFraction(state);
    if (fraction === null || fraction > setting.belowHealth) return;
    // The tier below the retreat: never above its floor while it is on, and
    // never across its move, which is answered first.
    const retreat = automation.safety.retreat;
    if (retreat.enabled && fraction > retreat.belowHealth) return;
    if (this.travel.escapeUnanswered || this.tracker.pendingMoves > 0) return;
    if (now - this.lastAsked < retreat.cooldownMs) return;

    const why = t('session.safety.whyHealth', { percent: percentText(fraction) });
    const command = setting.command;
    if (command.length === 0 || command === this.refused) {
      if (this.saidThisFight) return;
      this.saidThisFight = true;
      const refused =
        command.length === 0
          ? t('session.safety.teleportUnstated')
          : t('session.safety.teleportRefusedBefore', { command });
      this.session.notice(t('session.safety.teleportNot', { why, refused }));
      this.decided(why, false, refused);
      return;
    }

    this.lastAsked = now;
    this.travel.teleportSent(now);
    this.session.notice(t('session.safety.teleporting', { command, why }));
    const awaiting = {
      command,
      why,
      from: state.room,
      at: now,
      sent: false,
      deadline: now + tuning().session.retreatPatienceMs,
      echo: new EchoSince(command)
    };
    this.awaiting = awaiting;
    this.queue.enqueue({
      command,
      priority: 'emergency',
      coalesceKey: 'escape:teleport',
      reason: t('session.safety.teleportReason', { why }),
      // Dropped at the send once it is settled or the character is down.
      stillWanted: () => this.awaiting === awaiting && !this.grounded.down,
      onSent: () => {
        awaiting.sent = true;
        awaiting.deadline = Date.now() + tuning().session.retreatPatienceMs;
      }
    });
  }

  /**
   * What the realm said back, read against the block that just applied.
   * `answering` is the command the realm's own echo says the lines after it
   * answer (`SessionManager.answering`), read since the send (`EchoSince`): a
   * refusal echoed against another command is that command's, and one with no
   * echo since the send is taken as this one's for this attempt without being
   * kept for the connection.
   */
  settle(block: Block, answering: string | null): void {
    const waiting = this.awaiting;
    if (waiting === null) return;
    // A death drops it sent or not: `stillWanted` keeps an unsent one off the wire.
    if (block.type === 'user-dies') {
      this.awaiting = null;
      this.session.notice(t('session.safety.teleportDropped', { command: waiting.command }));
      this.decided(waiting.why, false, t('session.safety.escapeKilled'));
      this.travel.teleportRefused(waiting.at);
      return;
    }
    if (!waiting.sent) return;
    const now = Date.now();
    if (landed(this.tracker.current.room, waiting.from)) {
      this.awaiting = null;
      this.travel.teleportLanded(waiting.from, now);
      this.decided(waiting.why, true);
      return;
    }
    waiting.echo.heard(block, answering);
    if (REFUSALS.has(block.type) && waiting.echo.answers) {
      this.awaiting = null;
      if (KEPT.has(block.type) && waiting.echo.echoed) this.refused = waiting.command;
      this.travel.teleportRefused(waiting.at);
      this.session.notice(
        t('session.safety.teleportRefused', { command: waiting.command, answer: block.text })
      );
      this.decided(waiting.why, false, block.text);
      return;
    }
    this.giveUpIfLate(now);
  }

  private giveUpIfLate(now: number): void {
    const waiting = this.awaiting;
    if (waiting === null || now <= waiting.deadline) return;
    this.awaiting = null;
    this.travel.teleportRefused(waiting.at);
    const seconds = Math.round(tuning().session.retreatPatienceMs / 1000);
    this.session.notice(t('session.safety.teleportGaveUp', { command: waiting.command, seconds }));
    this.decided(waiting.why, false, t('session.safety.escapeUnanswered'));
  }

  private decided(because: string, acted: boolean, refused?: string): void {
    this.publisher.noteSafety({
      at: Date.now(),
      action: ACTION,
      because,
      acted,
      ...(refused === undefined ? {} : { refused })
    });
  }
}
