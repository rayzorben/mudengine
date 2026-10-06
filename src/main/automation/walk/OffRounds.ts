/**
 * A run's step out of an empty room into a lair, timed to the rounds (todo
 * 00, 2026-10-03; the user's move-move rule and lairs only, 2026-10-04). A
 * round hits whoever is in the room when its tick goes off. Such a step goes
 * at once while a step and another after it fit before the next round, so
 * the lair it lands in can still be left before that round; otherwise it
 * waits for the round and goes as it fires. A monster in the room or a fight
 * never holds, since a wait there gives the monster a free round; a step into
 * a room with no lair is not timed. Unknown rounds or step length hold
 * nothing, and so does `movement.runBetweenRounds` off. Whether the run is
 * timed is said each time the answer changes. See `mudengine-automation` ›
 * parts/walking.md › *A run steps in the off-rounds*.
 */
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import { fightIsRunning, monstersHere, type CharacterState } from '../../../shared/character';
import type { Block } from '../../../shared/blocks';
import type { MovementConfig } from '../../../shared/config';
import type { RouteStep } from '../../../shared/world';
import { RoundClock } from '../RoundClock';
import type { StepTimes } from './StepTimes';
import type { WalkerEvents } from './ports';

/**
 * How long to hold a step at `now`: 0 when two steps and `marginMs` fit
 * before the round at `nextRound`, or when that round went off within
 * `marginMs` (a step that cannot fit twice goes once a round, as it fires);
 * otherwise until the round.
 */
export function offRoundHoldMs(
  now: number,
  nextRound: number,
  periodMs: number,
  stepMs: number,
  marginMs: number
): number {
  const left = nextRound - now;
  if (left > 2 * stepMs + marginMs || periodMs - left <= marginMs) return 0;
  return left;
}

/** A fight, or a monster in the room: a wait here is a free round. */
function beset(state: CharacterState): boolean {
  return fightIsRunning(state) || monstersHere(state);
}

type Untimed = 'stepUnmeasured' | 'unmeasured';
type Said = 'timed' | Untimed;

/** Why a run is not timed, as said. */
function untimed(why: Untimed): string {
  switch (why) {
    case 'unmeasured':
      return t('automation.walk.offRoundsNoRounds');
    case 'stepUnmeasured':
      return t('automation.walk.offRoundsNoSteps');
    default: {
      const never: never = why;
      return never;
    }
  }
}

export class OffRounds {
  private readonly rounds: RoundClock;
  /** Whether the walk now going is a run. */
  private running = false;
  /** Which of the timing's answers was last said this walk, so each is said once. */
  private said: Said | null = null;
  /** The round a held step waits for, so a late timer sends it rather than waiting another. */
  private awaited: number | null = null;

  constructor(
    private readonly steps: StepTimes,
    private readonly events: Pick<WalkerEvents, 'notice' | 'realmSpeed'>,
    private readonly now: () => number = () => Date.now()
  ) {
    this.rounds = new RoundClock(() => events.realmSpeed?.() ?? 1);
  }

  onBlock(block: Block): void {
    this.rounds.onBlock(block);
  }

  /** A walk starts; `run` times its steps to the rounds. */
  begin(run: boolean): void {
    this.running = run;
    this.said = null;
    this.awaited = null;
  }

  /**
   * How long to hold `step` out of this room; 0 for none, and always 0 for a
   * step into a room with no lair or with `runBetweenRounds` off.
   */
  holdMs(
    state: CharacterState,
    step: RouteStep | undefined,
    movement: Pick<MovementConfig, 'runBetweenRounds'>,
    quiet: boolean
  ): number {
    const awaited = this.awaited;
    this.awaited = null;
    if (awaited !== null && this.now() >= awaited) return 0;
    if (step?.lair !== true || !movement.runBetweenRounds) return 0;
    const hold = this.timedHold(state, quiet);
    if (hold > 0) this.awaited = this.now() + hold;
    return hold;
  }

  /**
   * Whether a monster came into the room or a fight started while a step is
   * held here: the step then goes at once, or the wait gives it a free round.
   * Past the awaited round the step is another hold's, if it is held at all.
   */
  monsterCameIn(state: CharacterState): boolean {
    if (this.awaited === null || this.now() >= this.awaited || !beset(state)) return false;
    this.awaited = null;
    return true;
  }

  private timedHold(state: CharacterState, quiet: boolean): number {
    if (!this.running || beset(state)) return 0;
    const now = this.now();
    const next = this.rounds.next(now);
    const stepMs = this.steps.usual;
    if (!next.known || stepMs === null) {
      const why = next.known ? 'stepUnmeasured' : 'unmeasured';
      this.say(why, quiet, () => untimed(why));
      return 0;
    }
    this.say('timed', quiet, () =>
      t('automation.walk.offRoundsTimed', {
        round: (next.periodMs / 1000).toFixed(2),
        step: (stepMs / 1000).toFixed(2)
      })
    );
    return offRoundHoldMs(now, next.at, next.periodMs, stepMs, tuning().walk.offRoundMarginMs);
  }

  reset(): void {
    this.rounds.reset();
    this.running = false;
    this.said = null;
    this.awaited = null;
  }

  private say(said: Said, quiet: boolean, message: () => string): void {
    if (said === this.said) return;
    this.said = said;
    if (!quiet) this.events.notice?.(message());
  }
}
