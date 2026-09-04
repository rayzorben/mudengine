/**
 * The arbiter's vocabulary, and what it is currently doing.
 *
 * In `shared/` because three parties need it and they cannot all reach into the
 * main process: the queue enforces the priority order, a rule in the options
 * file *names* one of these bands, and the renderer draws the queue's state.
 *
 * It was previously defined twice — once as `PRIORITY` beside the queue, once
 * as a string union in `rules.ts` — which is the same mistake as holding two
 * representations of a direction: the two agree until one of them is edited.
 */
import type { RuleFiring } from './rules';

/**
 * Priority bands. Higher wins.
 *
 * `user` sits above everything automated, so a person typing is never queued
 * behind a bot's housekeeping.
 */
export const PRIORITY = {
  /** Get out. Nothing outranks this. */
  emergency: 100,
  combat: 80,
  /** Anything the person at the keyboard asked for, including login answers. */
  user: 60,
  /**
   * Walking a planned route. Below the player, who may be steering; above the
   * housekeeping probe, because the walk is the current task and the probe is a
   * one-off that can wait a step.
   */
  movement: 50,
  /** Asking the realm the questions that populate the HUD. */
  probe: 40,
  /** Keep-alive and other things worth doing only when nothing else is. */
  idle: 20
} as const;

export type Priority = keyof typeof PRIORITY;

/** One intent waiting its turn. */
export interface PendingIntent {
  command: string;
  priority: Priority;
  /** Why it was proposed. This is the trace. */
  reason?: string;
}

export interface QueueSnapshot {
  depth: number;
  /** Sent and not yet acknowledged by a prompt. */
  inFlight: number;
  /** Standing down because the player is typing. */
  suppressed: boolean;
  pending: PendingIntent[];
}

export const EMPTY_QUEUE: QueueSnapshot = {
  depth: 0,
  inFlight: 0,
  suppressed: false,
  pending: []
};

/**
 * One command the arbiter actually put on the wire.
 *
 * A rule that fired is not the same as a command that was sent: an intent can
 * be coalesced away, expire, or be cancelled between the two. Recording the
 * send separately is what makes "why did the bot run?" answerable — the
 * firing says a rule decided, this says the decision reached the game.
 */
export interface SentCommand {
  at: number;
  command: string;
  priority: Priority;
  reason?: string;
}

/**
 * What automation has been doing. The decision trace, in one payload.
 *
 * `RuleFiring` is imported as a type only, and `rules.ts` imports `Priority`
 * from here the same way, so there is no runtime edge in either direction.
 */
/**
 * Something the client did, or refused to do, to keep a character alive.
 *
 * Separate from `firings` because it is not a rule: a safety action knows
 * things a rule cannot — whether a disconnect would be penalised, for instance
 * — and one of them does not produce a command at all, so it would never appear
 * in `sent` either.
 *
 * **"Why did the bot run?" has to be answerable from a trace**
 * (docs/legacy-assessment.md §6), and hanging up is the one decision with a
 * consequence nothing can undo. A refusal is recorded as well as an action:
 * somebody who turned a safety feature on and found it did nothing needs to see
 * that it *decided* not to, and why.
 */
export interface SafetyDecision {
  at: number;
  /** `retreat` or `hang up`. */
  action: string;
  /** What prompted it — the health, the number of attackers. */
  because: string;
  /** True when it acted; false when it refused. */
  acted: boolean;
  /** Why it refused, when it did. */
  refused?: string;
}

/**
 * A fight auto-combat opened, or declined to open, and what decided it.
 *
 * The same shape and the same argument as {@link SafetyDecision}, applied to
 * the loudest thing in the client: **why the bot did *not* attack that** is a
 * question somebody asks several times an evening, and until this existed
 * there were eleven ways for `AutoCombat.engage` to decline and not one of them
 * said so. Answering it took replaying a recorded session through a bespoke
 * script and counting `rm` probes to work out whether a loop had been running.
 *
 * Recorded **only when the room held something it would otherwise have opened
 * on**, and only when the answer changes: a status line arrives every few
 * hundred milliseconds, and a trace with one line per prompt is the terminal
 * again — which is the thing every readout in this client exists instead of.
 */
export interface EngageDecision {
  at: number;
  /** The monster, as the room's own listing spelled it. */
  target: string;
  /** True when it swung; false when a gate stopped it. */
  acted: boolean;
  /** Which gate stopped it, when one did. */
  refused?: string;
  /**
   * Why *this* one, when it swung and the room held a choice.
   *
   * The refusals were written down first, because "why did it walk past" was
   * the question asked; "why did it hit the rat and not the ogre" is the
   * same question from the other side, and once the order stopped being the
   * room's listing it needed an answer that could be read back.
   */
  because?: string;
}

export interface AutomationSnapshot {
  /** False when `automation.enabled` is off: nothing here will act. */
  enabled: boolean;
  queue: QueueSnapshot;
  /** Newest first. */
  sent: SentCommand[];
  /** Newest first. Includes rules a guard rejected, and which guard. */
  firings: RuleFiring[];
  /** Newest first. What was done, or refused, to keep this character alive. */
  safety: SafetyDecision[];
  /** Newest first. What auto-combat opened on, or declined to and why. */
  engagements: EngageDecision[];
}

export const EMPTY_AUTOMATION: AutomationSnapshot = {
  enabled: false,
  queue: EMPTY_QUEUE,
  sent: [],
  firings: [],
  safety: [],
  engagements: []
};
