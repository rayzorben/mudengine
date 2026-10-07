/**
 * Ahead of the next step, when the character is meant to be sneaking and is
 * not.
 *
 * **Immediately before the step, every step, and that is the whole point.**
 * What it decides is whether the things in the *next* room notice the
 * arrival, so the only moment it can be decided from is the one the step
 * goes out in. This used to be asked in two places — once before a route's
 * first step and once when a hold let go — and that left the two cases the
 * walk provokes itself uncovered:
 *
 * - **A retry behind a door.** Picking or opening a barrier breaks stealth
 *   silently (`Door.cs`; the client now reads it, see
 *   `StealthReceipt.broke`), and the retry is not a fresh send, so
 *   nothing asked again. Reported 2026-09-11 as a character that sneaked,
 *   walked into a shut door, picked it, opened it and stepped through in
 *   plain sight.
 * - **Every ordinary step after the first.** A fight, a rest and equipping
 *   all break stealth, and a route's second step inherited whatever the
 *   first believed.
 *
 * Called from `Walker.sendCurrent` after `beforeStep`, so a torch readied for the
 * next room cannot break the stealth this just asked for: the two share the
 * `movement` band and the arbiter keeps a band in order. Coalesced, so a
 * retry that asks again while the first `sn` is still queued is one
 * command.
 *
 * `Stealth` is three-state for the reason this needs: `unknown` means nobody
 * has said, which is not `sneaking`, and a character that believes it is
 * hidden and is not walks into a lair in the open.
 *
 * **The step waits for the `sn`'s answer** (user, 2026-10-07): a loop sent
 * `sn`, got `You don't think you're sneaking.` and stepped east into a goblin
 * anyway, because the step was queued behind the `sn` unanswered. A refusal
 * asks again; the bare `Attempting to sneak...` lets the step go.
 */
import type { CommandQueue } from '../CommandQueue';
import type { BlockType } from '../../../shared/blocks';
import type { CharacterState } from '../../../shared/character';
import type { RouteStep } from '../../../shared/world';
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import type { WalkClock } from './clock';
import type { WalkInFlight, WalkerEvents } from './ports';

/** `AutoStealth`'s key too, so its `sn` and the walk's are one command. */
export const SNEAK_KEY = 'sneak';

export class SneakBeforeStep {
  /** Whether *Stealth 0, not sneaking* has been said this session. */
  private saidNoStealth = false;
  /**
   * Sneaks refused in a row (`You don't think you're sneaking.`), and the
   * level they were counted at: at `tuning.walk.sneakGiveUp` the walk stops
   * asking until a new connection or a new level, said once. A low figure is
   * a refusal the sheet cannot show (`SneakCommand.cs` rolls against Stealth
   * less what is in the room), so it is read off the answers.
   */
  private sneakRefusals = { count: 0, level: null as number | null };
  /**
   * The step held behind an `sn`, and whether the server has answered it:
   * `heard` lets the next ask send the step. A step that is no longer the one
   * in flight (the walk stopped or moved on) is waiting on nothing.
   */
  private answer: { step: RouteStep; heard: boolean } | null = null;

  constructor(
    private readonly queue: Pick<CommandQueue, 'offer' | 'queued'>,
    private readonly events: Pick<WalkerEvents, 'notice'>,
    /** A room the server refuses `sn` in (`cannotSneakHere`). */
    private readonly blocked: (state: CharacterState) => boolean,
    private readonly inFlight: Pick<WalkInFlight, 'walking' | 'step' | 'stepWhenFree'>,
    private readonly clock: Pick<WalkClock, 'afterStep' | 'clear'>
  ) {}

  /** A new connection, possibly another server: everything counted starts again. */
  reset(): void {
    this.sneakRefusals = { count: 0, level: null };
    this.answer = null;
  }

  /**
   * Asks for an `sn` ahead of the step when one is wanted. True while the
   * step waits for the answer (`answered`); false when the step can go.
   */
  ask(state: CharacterState, wanted: boolean): boolean {
    // Heard: the step goes. An `sn` still unanswered when the step is sent
    // again (a hold let go, the clock and its deadline cleared) is asked again.
    const heard = this.held()?.heard === true;
    this.answer = null;
    if (heard || !wanted) return false;
    // Sneaking, by the tracker's own reading: the refusals in a row are over.
    if (state.stealth === 'sneaking') {
      if (this.sneakRefusals.count < tuning().walk.sneakGiveUp) this.sneakRefusals.count = 0;
      return false;
    }
    /*
     * **A sheet that says `Stealth: 0` is never asked to sneak** (todo 104).
     * `SneakCommand.cs` rolls `Stealth − (players − 1 + mobs) ≥ rand(1,100)`,
     * so a figure of zero never passes — and a Mage rerolled from a Ninja
     * kept `movement.sneak` and spent one refused `sn` on every step of every
     * lap. The figure is the sheet's own column; an unread sheet (null) never
     * refuses, and a Ninja whose figure is low is still asked every step.
     */
    if (state.progress.stealthSkill === 0) {
      if (!this.saidNoStealth) {
        this.saidNoStealth = true;
        this.events.notice?.(t('automation.walk.sneakNoSkill'));
      }
      return false;
    }
    if (this.blocked(state)) return false;
    // Refused too often in a row at this level: stopped until it changes.
    if (this.sneakRefusals.level !== state.progress.level) {
      this.sneakRefusals = { count: 0, level: state.progress.level };
    }
    if (this.sneakRefusals.count >= tuning().walk.sneakGiveUp) return false;
    const step = this.inFlight.step();
    if (step === undefined) return false;
    // Ahead of the offer: an idle queue sends inside it, and `onSent` reads this.
    this.answer = { step, heard: false };
    const offered = this.queue.offer({
      command: 'sn',
      priority: 'movement',
      coalesceKey: SNEAK_KEY,
      reason: t('automation.walk.reasonSneak'),
      onSent: () => this.waitForAnswer(step)
    });
    // `joined`: `AutoStealth`'s `sn` under the same key, whose answer is as good.
    if (offered !== 'queued' && offered !== 'joined') {
      this.answer = null;
      return false;
    }
    // Not sent inside the offer: watched until it is (`waitForAnswer`).
    if (this.stillQueued()) this.waitForSend(step);
    return true;
  }

  private stillQueued(): boolean {
    return this.queue.queued((intent) => intent.coalesceKey === SNEAK_KEY);
  }

  /**
   * While the `sn` waits in the queue, behind the window or a half-typed
   * line, the step waits with it. An `sn` the queue dropped (the stat screen
   * clears it) is never answered, so the step goes and says so.
   */
  private waitForSend(step: RouteStep): void {
    this.clock.afterStep(tuning().walk.sneakAnswerMs, () => {
      if (this.held()?.step !== step) return;
      if (this.stillQueued()) return this.waitForSend(step);
      this.events.notice?.(t('automation.walk.sneakUnanswered'));
      this.goOn(true);
    });
  }

  /**
   * From the send, so a half-typed line holding the `sn` in the queue spends
   * none of it. A lost answer sends the step unsneaked and says so.
   */
  private waitForAnswer(step: RouteStep): void {
    if (this.held()?.step !== step) return;
    this.clock.clear();
    this.clock.afterStep(tuning().walk.sneakAnswerMs, () => {
      if (this.held() === null) return;
      this.events.notice?.(t('automation.walk.sneakUnanswered'));
      this.goOn(true);
    });
  }

  /**
   * The server answered an `sn`. A step held on it is sent again: after a
   * refusal that asks once more (up to `sneakGiveUp`), otherwise it steps.
   */
  answered(type: SneakAnswer): void {
    if (type === 'user-sneak-failed') this.refused();
    if (this.held() === null) return;
    this.goOn(type !== 'user-sneak-failed');
  }

  /** The step held on an `sn`, or null. */
  private held(): { step: RouteStep; heard: boolean } | null {
    const answer = this.answer;
    if (answer === null || !this.inFlight.walking()) return null;
    return answer.step === this.inFlight.step() ? answer : null;
  }

  /**
   * The step again, through the holds: a fight or a hold that came up while
   * the `sn` was out takes the walk, and the answer it did not spend is
   * dropped, so the step asks again when the hold lets go.
   */
  private goOn(heard: boolean): void {
    this.clock.clear();
    this.answer = heard && this.answer !== null ? { ...this.answer, heard } : null;
    this.inFlight.stepWhenFree();
    if (this.answer?.heard === true) this.answer = null;
  }

  /** One more sneak refused; at the limit, said once. See `sneakRefusals`. */
  private refused(): void {
    this.sneakRefusals.count += 1;
    if (this.sneakRefusals.count !== tuning().walk.sneakGiveUp) return;
    this.events.notice?.(t('automation.walk.sneakGaveUp', { count: this.sneakRefusals.count }));
  }
}

/**
 * The server's answers to `sn`: the bare attempt, the refusal glued to it, and
 * `You may not sneak right now!`. `Sneaking...` is a move's receipt, not one.
 */
export type SneakAnswer = Extract<
  BlockType,
  'user-sneak-initiate' | 'user-sneak-failed' | 'user-cant-sneak'
>;

export function isSneakAnswer(type: BlockType): type is SneakAnswer {
  return (
    type === 'user-sneak-initiate' || type === 'user-sneak-failed' || type === 'user-cant-sneak'
  );
}
