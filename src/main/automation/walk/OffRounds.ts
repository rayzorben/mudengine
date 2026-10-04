/**
 * A run's step out of an empty room, timed to the rounds (todo 00,
 * 2026-10-03). A round hits whoever is in the room when its tick goes off, and
 * a character stays in the room it is leaving for the whole of the server's
 * movement delay, so a step from a room with nothing in it is held only where
 * its arrival would land just before the next round: it then lands just after
 * it, and the round goes off over the empty room. A room with a monster, or a
 * fight, never holds. Unknown rounds or step length hold nothing. Whether the
 * run is timed is said each time the answer changes. See `mudengine-automation` › parts/walking.md › *A run steps in the
 * off-rounds*.
 */
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import { fightIsRunning, type CharacterState } from '../../../shared/character';
import type { Block } from '../../../shared/blocks';
import { RoundClock } from '../RoundClock';
import type { StepTimes } from './StepTimes';
import type { WalkerEvents } from './ports';

/**
 * How long to hold a step sent at `now` so that it does not arrive within
 * `marginMs` before the round at `nextRound`: 0 when it arrives earlier than
 * that (still in this off-round) or after the round anyway.
 */
export function offRoundHoldMs(
  now: number,
  nextRound: number,
  stepMs: number,
  marginMs: number
): number {
  const arrival = now + stepMs;
  if (arrival <= nextRound - marginMs) return 0;
  return Math.max(0, nextRound + marginMs - arrival);
}

type Untimed = 'stepUnmeasured' | 'unmeasured' | 'stale';
type Said = 'timed' | Untimed;

/** Why a run is not timed, as said. */
function untimed(why: Untimed): string {
  switch (why) {
    case 'unmeasured':
      return t('automation.walk.offRoundsNoRounds');
    case 'stale':
      return t('automation.walk.offRoundsStale');
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
  }

  /** How long to hold the step out of this room; 0 for none. */
  holdMs(state: CharacterState, quiet: boolean): number {
    if (!this.running) return 0;
    if (fightIsRunning(state) || state.room.occupants.some((who) => who.kind !== 'player'))
      return 0;
    const now = this.now();
    const next = this.rounds.next(now, tuning().walk.offRoundForgetRounds);
    const stepMs = this.steps.usual;
    if (!next.known || stepMs === null) {
      const why = next.known ? 'stepUnmeasured' : next.why;
      this.say(why, quiet, () => untimed(why));
      return 0;
    }
    this.say('timed', quiet, () =>
      t('automation.walk.offRoundsTimed', {
        round: (next.periodMs / 1000).toFixed(2),
        step: (stepMs / 1000).toFixed(2)
      })
    );
    return offRoundHoldMs(now, next.at, stepMs, tuning().walk.offRoundMarginMs);
  }

  reset(): void {
    this.rounds.reset();
    this.running = false;
    this.said = null;
  }

  private say(said: Said, quiet: boolean, message: () => string): void {
    if (said === this.said) return;
    this.said = said;
    if (!quiet) this.events.notice?.(message());
  }
}
