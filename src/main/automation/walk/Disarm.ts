/**
 * Ahead of a step into a trapped way, `disarm trap <dir>` when the odds make
 * it cost less than walking in (todo 53). Asked from `Walker.sendCurrent`
 * after the holds, so the trap hold has already rested the character to what
 * the trap takes: a failed disarm fires it for its full damage, the same as
 * walking in (`TrapExit.TryDisarm`). Before the sneak, since a failure breaks
 * stealth. A failure has no fixed line (it is the exit's own message), so the
 * answer is the success line or the deadline, which counts as a failure and
 * goes back through the holds. Leading, a member with better odds is sent
 * instead (`PartyHands`, todo 86). The why is `mudengine-automation` ›
 * `parts/walking.md`.
 */
import type { CommandQueue } from '../CommandQueue';
import type { CharacterState } from '../../../shared/character';
import type { MovementConfig } from '../../../shared/config';
import {
  TRAP_JOBS,
  jobCommand,
  walkersThrough,
  type HandAnswer
} from '../../../shared/barrierHands';
import { disarmTries, disarmWorth } from '../../../shared/walk';
import { asSpokenDirection, trapOn, type RouteStep } from '../../../shared/world';
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import type { WalkClock } from './clock';
import { wayOf, type WalkInFlight, type WalkerEvents } from './ports';
import type { PartyHands } from './PartyHands';

const DISARM_KEY = 'disarm-trap';

export class DisarmBeforeStep {
  /** Ways this session saw disarmed, and until when they are safe to walk. */
  private readonly safeUntil = new Map<string, number>();
  /** Failed tries in a row at one way, and the ways given up on at the Traps they failed at. */
  private failed = { way: null as string | null, count: 0 };
  private readonly givenUp = new Map<string, number | null>();
  /** The step waiting on a `disarm` answer, and whether the command reached the wire. */
  private waiting: RouteStep | null = null;
  private sent = false;
  private odds = 0;
  /** `movement.disarmDoubt` at the ask, which the failures it answers are counted against. */
  private doubt = 0;
  private traps: number | null = null;

  constructor(
    private readonly queue: Pick<CommandQueue, 'offer' | 'queued'>,
    private readonly events: Pick<WalkerEvents, 'notice' | 'moveOnly'>,
    private readonly inFlight: Pick<WalkInFlight, 'walking' | 'quiet' | 'step' | 'stepWhenFree'>,
    private readonly clock: Pick<WalkClock, 'afterStep' | 'clear'>,
    private readonly hands: Pick<PartyHands, 'best' | 'ask' | 'waitingAt'>,
    private readonly now: () => number = Date.now
  ) {}

  /** A new connection: what was disarmed may have re-armed, and the counts start again. */
  reset(): void {
    this.safeUntil.clear();
    this.givenUp.clear();
    this.failed = { way: null, count: 0 };
    this.waiting = null;
  }

  /** Whether this step's trap is disarmed for now, so neither the trap hold nor a disarm is wanted. */
  disarmed(step: RouteStep): boolean {
    const until = this.safeUntil.get(wayOf(step));
    return until !== undefined && this.now() < until;
  }

  /**
   * Sends `disarm trap <dir>` ahead of the step when it is wanted. True while
   * the step waits for the answer; false when the step can go.
   */
  ask(
    state: CharacterState,
    movement: Pick<MovementConfig, 'disarmTraps' | 'disarmDoubt'>
  ): boolean {
    const step = this.inFlight.step();
    if (step === undefined) return false;
    // Asked again while one is out (a fight hold cleared the clock): wait again.
    if (this.waiting === step) {
      this.deadline(step);
      return true;
    }
    if (this.hands.waitingAt(step, TRAP_JOBS)) return true;
    if (trapOn(step) === null || step.direction === 'portal') return false;
    // Auto-Disarm Traps off: the trap hold rests for the trap and the step walks in.
    if (!movement.disarmTraps) return false;
    if (this.disarmed(step)) return false;
    // Inside a timed spell's corridor the next step is the one thing that helps (todo 104).
    if (this.events.moveOnly?.(state) === true) return false;
    // Given up at these Traps; a trained or levelled figure tries again.
    const gaveUpAt = this.givenUp.get(wayOf(step));
    const selfDone = gaveUpAt !== undefined && gaveUpAt === state.progress.traps;
    this.traps = state.progress.traps;
    this.doubt = movement.disarmDoubt;
    // The best hand here, a member leading; worth it for everyone who walks the way.
    const hand = this.hands.best('disarm', step, state, selfDone);
    if (hand === null || hand.odds === null || !disarmWorth(hand.odds, walkersThrough(state))) {
      return false;
    }
    if (!hand.self) {
      const tries = disarmTries(hand.odds, movement.disarmDoubt);
      // A failed disarm fires the trap at whoever tried, so this character waits on the member.
      if (
        this.hands.ask('disarm', step, hand, tries, (answer) => this.memberAnswered(step, answer))
      ) {
        return this.hands.waitingAt(step, TRAP_JOBS);
      }
      // Nothing went to them; they count as asked, so the next hand is asked.
      return this.ask(state, movement);
    }
    const odds = hand.odds;
    this.waiting = step;
    this.sent = false;
    this.odds = odds;
    const offered = this.queue.offer({
      command: jobCommand('disarm', step.direction),
      priority: 'movement',
      coalesceKey: DISARM_KEY,
      reason: t('automation.walk.reasonDisarm', { stepName: step.name }),
      decision: 'trap-disarm',
      onSent: () => this.waitForAnswer(step)
    });
    if (offered !== 'queued' && offered !== 'joined') {
      this.waiting = null;
      return false;
    }
    // A `disarm` the queue drops (the stat screen clears it) is never answered.
    if (!this.sent) this.deadline(step);
    return true;
  }

  /** `trap-disarmed`: the way is safe; the step goes through the holds. */
  answered(said: string | undefined): void {
    const step = this.inFlight.step();
    if (step === undefined || !this.inFlight.walking()) return;
    const about = said === undefined ? null : asSpokenDirection(said);
    // `already disarmed` names no way, so it answers only a disarm out for this step.
    if (about === null ? this.waiting !== step : about !== step.direction) return;
    // `already disarmed` says nothing of when, so it covers this send only.
    const safeFor = about === null ? tuning().walk.disarmAnswerMs : tuning().walk.trapRearmMs;
    this.safeUntil.set(wayOf(step), this.now() + safeFor);
    this.failed = { way: null, count: 0 };
    this.givenUp.delete(wayOf(step));
    // A disarm the player typed is recorded; only the walk's own sends the step.
    if (this.waiting !== step) return;
    if (!this.inFlight.quiet()) {
      this.events.notice?.(
        t('automation.walk.trapDisarmed', { stepName: step.name }),
        'trap-disarm'
      );
    }
    this.goOn();
  }

  /** A member's answer: a disarm holds the way for the re-arm; a failure asks the next hand. */
  private memberAnswered(step: RouteStep, answer: HandAnswer): void {
    if (answer === 'held') this.safeUntil.set(wayOf(step), this.now() + tuning().walk.trapRearmMs);
    this.goOn();
  }

  /** From the send: no success line by the deadline is a failure, counted. */
  private waitForAnswer(step: RouteStep): void {
    if (this.waiting !== step) return;
    this.sent = true;
    this.deadline(step);
  }

  /**
   * Sent, no success line by the deadline is a failed try. Unsent, the step
   * waits while the `disarm` is still queued (a half-typed line holds it); one
   * the queue dropped (the stat screen clears it) is never answered, so the
   * step goes on uncounted and says so.
   */
  private deadline(step: RouteStep): void {
    this.clock.clear();
    this.clock.afterStep(tuning().walk.disarmAnswerMs, () => {
      if (this.waiting !== step || !this.inFlight.walking()) return;
      if (this.sent) this.failedOnce(step);
      else if (this.queue.queued((intent) => intent.coalesceKey === DISARM_KEY)) {
        return this.deadline(step);
      } else
        this.events.notice?.(
          t('automation.walk.disarmUnsent', { stepName: step.name }),
          'trap-disarm'
        );
      this.goOn();
    });
  }

  private failedOnce(step: RouteStep): void {
    const way = wayOf(step);
    this.failed = { way, count: this.failed.way === way ? this.failed.count + 1 : 1 };
    const limit = disarmTries(this.odds, this.doubt);
    if (this.failed.count < limit) return;
    this.givenUp.set(way, this.traps);
    this.events.notice?.(
      t('automation.walk.disarmGaveUp', { stepName: step.name, count: this.failed.count }),
      'trap-disarm'
    );
  }

  /** The step again, through the holds: the trap hold rests for the next try. */
  private goOn(): void {
    this.clock.clear();
    this.waiting = null;
    this.inFlight.stepWhenFree();
  }
}
