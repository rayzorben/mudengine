/**
 * Walking to a room and parting with named items there by one verb (`sell`,
 * `hide`, `drop`), or taking them in (`buy`), one item at a time: the pack
 * holding fewer (more, for `receives`) is the confirmation, and silence past
 * `confirmMs` (`tuning.outgrown.confirmMs` unsaid) after the verb went out is
 * a refusal. Out of `OutgrownGear`, so getting rid of outgrown
 * gear and an extension's sale are one walk and one confirmation. The owner
 * says what each ending means; this reports which ending it was. See
 * `mudengine-automation` › *Outgrown gear is stashed, sold or dropped*.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { CharacterState } from '../../shared/character';
import { carriedCount } from '../../shared/supplies';
import type { RoomId, Route } from '../../shared/world';

export interface HandoverPlanner {
  /** Where the character stands, or null while unplaced. */
  here(): RoomId | null;
  /** A route to a room, or the reason there is none. */
  routeTo(room: RoomId): Route | string;
  /** Hands the route to the walker as a leg. Returns its refusal, or null. */
  walk(route: Route): string | null;
}

/** Where, by which verb, which items, and the owner's words for each command sent. */
export interface HandoverAsk {
  /** The room the verb is sent in; null is where the character stands. */
  at: RoomId | null;
  verb: string;
  items: readonly string[];
  /** The verb's coalescing key starts with it, so two owners never join. */
  key: string;
  /** Why each verb is sent, as the trace says it. */
  reason(item: string): string;
  /** The verb puts the item in the pack (`buy`) rather than taking it out. */
  receives?: boolean;
  confirmMs?: number;
}

export type HandoverStart =
  { kind: 'here' } | { kind: 'walking'; steps: number } | { kind: 'refused'; why: string };

export type HandoverEnd =
  /** The walk stopped short, or arrived somewhere else; `why` is the walk's reason. */
  | { kind: 'not-reached'; why: string | null }
  /**
   * Every item had its verb: `gone` the pack lost (or gained, for
   * `receives`), `unanswered` it did not
   * once the verb went out, `unsent` the queue would not take or dropped unsent.
   */
  | { kind: 'handed'; gone: string[]; unanswered: string[]; unsent: string[] };

export interface HandoverEvents {
  ended(end: HandoverEnd, state: CharacterState): void;
}

/** Where a handover stands, for a card. */
export type HandoverStage = 'walking' | 'acting';

interface Outcome {
  gone: string[];
  unanswered: string[];
  unsent: string[];
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'walking'; ask: HandoverAsk }
  /** `sentAt` null while the verb for `items[index]` waits in the queue. */
  | {
      kind: 'acting';
      ask: HandoverAsk;
      index: number;
      before: number;
      queuedAt: number;
      sentAt: number | null;
      outcome: Outcome;
    };

export class Handover {
  private phase: Phase = { kind: 'idle' };

  constructor(
    private readonly queue: CommandQueue,
    private readonly planner: HandoverPlanner,
    private readonly events: HandoverEvents,
    private readonly now: () => number = () => Date.now()
  ) {}

  get busy(): boolean {
    return this.phase.kind !== 'idle';
  }

  get stage(): HandoverStage | null {
    return this.phase.kind === 'idle' ? null : this.phase.kind;
  }

  /** Put down without an ending: what it still has queued is taken back. */
  cancel(): void {
    const phase = this.phase;
    this.phase = { kind: 'idle' };
    if (phase.kind === 'idle') return;
    const ours = `${phase.ask.key}:`;
    this.queue.cancel((intent) => intent.coalesceKey?.startsWith(ours) === true);
  }

  /**
   * Starts the walk, or the first verb where the character already stands.
   * The owner calls it only while not `busy`. Standing there, an ending may be
   * reported before this returns.
   */
  start(ask: HandoverAsk, state: CharacterState): HandoverStart {
    if (ask.at === null || ask.at === this.planner.here()) {
      this.act(ask, 0, { gone: [], unanswered: [], unsent: [] }, state);
      return { kind: 'here' };
    }
    const route = this.planner.routeTo(ask.at);
    if (typeof route === 'string') return { kind: 'refused', why: route };
    // A blocked route is a reason, not a walk of no steps.
    if (route.blocked) {
      return { kind: 'refused', why: route.reason ?? t('automation.walk.refusalNoRoute') };
    }
    const refused = this.planner.walk(route);
    if (refused !== null) return { kind: 'refused', why: refused };
    this.phase = { kind: 'walking', ask };
    return { kind: 'walking', steps: route.steps.length };
  }

  /** The walker's report: this leg ended, or somebody else's walk did. */
  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    if (this.phase.kind !== 'walking') return;
    const { ask } = this.phase;
    if (!arrived || this.planner.here() !== ask.at) {
      this.end({ kind: 'not-reached', why: reason }, state);
      return;
    }
    this.act(ask, 0, { gone: [], unanswered: [], unsent: [] }, state);
  }

  /** The pack holding fewer is the confirmation; silence past `confirmMs` is a refusal. */
  onCharacter(state: CharacterState): void {
    const phase = this.phase;
    if (phase.kind !== 'acting') return;
    const { ask, index, before, queuedAt, sentAt, outcome } = phase;
    const item = ask.items[index]!;
    const confirmMs = ask.confirmMs ?? tuning().outgrown.confirmMs;
    const now = carriedCount(state, item);
    if (ask.receives === true ? now > before : now < before) outcome.gone.push(item);
    // Dropped from the queue unsent: nothing was refused.
    else if (sentAt === null && this.now() - queuedAt >= confirmMs) outcome.unsent.push(item);
    else if (sentAt !== null && this.now() - sentAt >= confirmMs) outcome.unanswered.push(item);
    else return;
    this.act(ask, index + 1, outcome, state);
  }

  /** The verb for the item at `index`, or the ending once every item has had one. */
  private act(ask: HandoverAsk, index: number, outcome: Outcome, state: CharacterState): void {
    const item = ask.items[index];
    if (item === undefined) {
      this.end({ kind: 'handed', ...outcome }, state);
      return;
    }
    const phase: Phase = {
      kind: 'acting',
      ask,
      index,
      before: carriedCount(state, item),
      queuedAt: this.now(),
      sentAt: null,
      outcome
    };
    this.phase = phase;
    const offered = this.queue.offer({
      command: `${ask.verb} ${item}`,
      priority: 'probe',
      coalesceKey: `${ask.key}:act`,
      reason: ask.reason(item),
      onSent: () => {
        if (this.phase === phase) phase.sentAt = this.now();
      }
    });
    if (offered === 'queued' || offered === 'joined') return;
    outcome.unsent.push(item);
    this.act(ask, index + 1, outcome, state);
  }

  private end(end: HandoverEnd, state: CharacterState): void {
    this.phase = { kind: 'idle' };
    this.events.ended(end, state);
  }
}
