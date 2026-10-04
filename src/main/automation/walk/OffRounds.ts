/**
 * A run's step out of an empty room, timed to the rounds (todo 00,
 * 2026-10-03; the user's move-move rule 2026-10-04). A round hits whoever is
 * in the room when its tick goes off. A step from a room with nothing in it
 * goes at once while a step and another after it fit before the next round,
 * so the room it lands in can still be left before that round; otherwise it
 * waits for the round and goes as it fires. A room with a monster, or a
 * fight, never holds. Unknown rounds or step length hold nothing. Whether the
 * run is timed is said each time the answer changes. See
 * `mudengine-automation` › parts/walking.md › *A run steps in the off-rounds*.
 */
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import { fightIsRunning, type CharacterState } from '../../../shared/character';
import type { Block } from '../../../shared/blocks';
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
  private readonly rounds = new RoundClock();
  /** Whether the walk now going is a run. */
  private running = false;
  /** Which of the timing's answers was last said this walk, so each is said once. */
  private said: Said | null = null;
  /** The round a held step waits for, so a late timer sends it rather than waiting another. */
  private awaited: number | null = null;

  constructor(
    private readonly steps: StepTimes,
    private readonly events: Pick<WalkerEvents, 'notice'>,
    private readonly now: () => number = () => Date.now()
  ) {}

  onBlock(block: Block): void {
    this.rounds.onBlock(block);
  }

  /** A walk starts; `run` times its steps to the rounds. */
  begin(run: boolean): void {
    this.running = run;
    this.said = null;
    this.awaited = null;
  }

  /** How long to hold the step out of this room; 0 for none. */
  holdMs(state: CharacterState, quiet: boolean): number {
    const awaited = this.awaited;
    this.awaited = null;
    if (awaited !== null && this.now() >= awaited) return 0;
    const hold = this.timedHold(state, quiet);
    if (hold > 0) this.awaited = this.now() + hold;
    return hold;
  }

  private timedHold(state: CharacterState, quiet: boolean): number {
    if (!this.running) return 0;
    if (fightIsRunning(state) || state.room.occupants.some((who) => who.kind !== 'player'))
      return 0;
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
