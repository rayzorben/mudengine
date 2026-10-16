/**
 * Leading, the party member sent at a trapped way or a locked door (todo 86):
 * the best odds among this character and the members standing here
 * (`handsFor`), each member asked once per way until the answer. `@disarm`,
 * `@pick` or `@bash` goes to a mudengine member and `@do …` to another
 * client, a pick only (`WalkerEvents.askHand`); the member's answer
 * (`HandAnswer`) comes back through `Walker.handAnswered`, and silence lapses
 * as a failure once the step waits on it. Each ask ends once, answered,
 * lapsed or dropped, and withdraws itself from the session then (todo 133).
 * Asked by `DisarmBeforeStep` and `Barriers`, which keep their own tries for
 * this character. `mudengine-automation` › parts/remotes.md.
 */
import {
  candidatesHere,
  handsFor,
  unknownPickers,
  type BarrierJob,
  type HandAnswer,
  type HandAsk
} from '../../../shared/barrierHands';
import type { CharacterState } from '../../../shared/character';
import { playerKey } from '../../../shared/players';
import { DIRECTION_NAME, trapOn, type RouteStep } from '../../../shared/world';
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import type { WalkClock } from './clock';
import { wayOf, type WalkInFlight, type WalkerEvents } from './ports';

/** Who goes: this character, or a member with known odds or (a pick only) none. */
export interface PartyHand {
  name: string;
  self: boolean;
  odds: number | null;
}

interface Out {
  step: RouteStep;
  job: BarrierJob;
  name: string;
  until: number;
  asked: HandAsk;
  /** Whether the step waits on the answer, so the lapse holds the walk's clock. */
  waiting: boolean;
  then(answer: HandAnswer): void;
}

export class PartyHands {
  /** Members already asked at the way the walk stands at, by `playerKey`; another way starts afresh. */
  private tried = { way: '', names: new Set<string>() };
  private out: Out | null = null;

  constructor(
    private readonly events: Pick<WalkerEvents, 'notice' | 'askHand'>,
    private readonly inFlight: Pick<WalkInFlight, 'walking'>,
    private readonly clock: Pick<WalkClock, 'afterStep' | 'clear'>,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * The best hand at the step's way not yet asked there, or null. Following,
   * only this character: the leader's walk sends the party. `selfDone` leaves
   * this character out (its own tries are spent or switched off).
   */
  best(
    job: BarrierJob,
    step: RouteStep,
    state: CharacterState,
    selfDone: boolean
  ): PartyHand | null {
    if (step.direction === 'portal') return null;
    const leading = state.party.following === null;
    const asked = this.askedAt(wayOf(step));
    const fresh = (name: string, self: boolean): boolean =>
      self ? !selfDone : leading && !asked.has(playerKey(name));
    const damage = job === 'disarm' ? (trapOn(step)?.damage ?? null) : null;
    const candidates = candidatesHere(state);
    const known = handsFor(job, step.requirement, damage, candidates).find((hand) =>
      fresh(hand.name, hand.self)
    );
    if (known !== undefined) return known;
    if (job !== 'pick') return null;
    const unknown = unknownPickers(candidates).find((name) => fresh(name, false));
    return unknown === undefined ? null : { name: unknown, self: false, odds: null };
  }

  /**
   * Sends the member at the way. True when it went, false when nothing did,
   * and the member counts as asked either way. The step waits on the answer
   * only through `waitingAt`. `tries` is the member's bound, which sets how
   * long its answer may take.
   */
  ask(
    job: BarrierJob,
    step: RouteStep,
    hand: PartyHand,
    tries: number,
    then: (answer: HandAnswer) => void
  ): boolean {
    this.askedAt(wayOf(step)).add(playerKey(hand.name));
    const words = this.words(job, step, hand.name);
    // A portal is no exit a member can be sent at; `best` names nobody there.
    const asked =
      step.direction !== 'portal' &&
      (this.events.askHand?.(hand.name, job, step.direction) ?? false);
    if (asked === false) {
      this.events.notice?.(t('automation.walk.handUnsent', words));
      return false;
    }
    this.events.notice?.(
      hand.odds === null
        ? t('automation.walk.handAskedUnknown', words)
        : t('automation.walk.handAsked', { ...words, percent: Math.round(hand.odds * 100) })
    );
    const { remotes, walk } = tuning();
    const until = this.now() + remotes.replyMs + Math.max(1, tries) * walk.disarmAnswerMs;
    this.drop();
    this.out = { step, job, name: hand.name, until, asked, waiting: false, then };
    return true;
  }

  /** Whether a member is asked at the step's way for one of `jobs`, their answer still to come. */
  asking(step: RouteStep, jobs: readonly BarrierJob[]): boolean {
    return this.out?.step === step && jobs.includes(this.out.job);
  }

  /** The step waits on that member's answer; the deadline is armed again (a hold cleared it). */
  waitingAt(step: RouteStep, jobs: readonly BarrierJob[]): boolean {
    const out = this.out;
    if (out === null || !this.asking(step, jobs)) return false;
    this.out = { ...out, waiting: true };
    this.arm();
    return true;
  }

  /** A member's answer; only the one asked is read. */
  answered(name: string, answer: HandAnswer): void {
    const out = this.out;
    if (out === null || playerKey(out.name) !== playerKey(name)) return;
    this.events.notice?.(said(answer, this.words(out.job, out.step, out.name)));
    // Held, the way is behind the party; a `tried` pick stays asked, so a lock that held asks the next.
    if (answer === 'held') this.forget(out.step);
    this.settle(out, answer);
  }

  /** The way is behind the walk, or the ladder runs again: every member may be asked again. */
  forget(step: RouteStep): void {
    if (this.tried.way === wayOf(step)) this.tried.names.clear();
  }

  /**
   * The walk no longer waits on the member: it stopped, the door opened, or
   * the way is behind it. Their answer, when it comes, is no answer to the
   * walk. The lapse, if armed, finds nothing out and does nothing.
   */
  drop(): void {
    const out = this.out;
    if (out === null) return;
    this.out = null;
    out.asked.withdraw();
  }

  reset(): void {
    this.tried = { way: '', names: new Set<string>() };
    this.drop();
  }

  private askedAt(way: string): Set<string> {
    if (this.tried.way !== way) this.tried = { way, names: new Set<string>() };
    return this.tried.names;
  }

  private arm(): void {
    const out = this.out;
    if (out === null) return;
    this.clock.clear();
    this.clock.afterStep(Math.max(0, out.until - this.now()), () => {
      if (this.out !== out) return;
      if (!this.inFlight.walking()) return this.drop();
      this.events.notice?.(
        t('automation.walk.handLapsed', this.words(out.job, out.step, out.name))
      );
      this.settle(out, 'failed');
    });
  }

  private settle(out: Out, answer: HandAnswer): void {
    this.out = null;
    out.asked.withdraw();
    // When the step is not waiting on the member, the clock times this
    // character's own try, so it is left armed.
    if (out.waiting) this.clock.clear();
    out.then(answer);
  }

  private words(
    job: BarrierJob,
    step: RouteStep,
    who: string
  ): { who: string; job: string; direction: string } {
    const direction = step.direction === 'portal' ? step.name : DIRECTION_NAME[step.direction];
    return { who, job: jobWord(job), direction };
  }
}

/** What the console says of a member's answer. */
function said(answer: HandAnswer, words: { who: string; job: string; direction: string }): string {
  switch (answer) {
    case 'held':
      return t('automation.walk.handHeld', words);
    case 'failed':
      return t('automation.walk.handFailed', words);
    case 'tried':
      return t('automation.walk.handTried', words);
    default: {
      const never: never = answer;
      return never;
    }
  }
}

/** The job as a notice says it. */
function jobWord(job: BarrierJob): string {
  switch (job) {
    case 'disarm':
      return t('automation.walk.handJobDisarm');
    case 'pick':
      return t('automation.walk.handJobPick');
    case 'bash':
      return t('automation.walk.handJobBash');
    default: {
      const never: never = job;
      return never;
    }
  }
}
