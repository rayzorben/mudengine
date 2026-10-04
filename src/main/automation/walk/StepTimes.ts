/**
 * How long this realm takes to answer a move: from the step reaching the wire
 * to the room that answers it, the last `walk.nudgeSamples` of them. It is
 * the server's movement delay, which grows with the pack's weight
 * (`MoveCommand.cs`: 1,100 ms plus up to 2,000 by encumbrance), plus the round
 * trip. The slowest is the nudge's deadline; the median is a step's length for
 * timing a run to the rounds. Kept per connection. See `mudengine-automation`
 * › parts/walking.md.
 */
import { tuning } from '../../app/tuning';
import { median } from '../../../shared/median';

export class StepTimes {
  private answers: number[] = [];
  /** When the step outstanding reached the wire, or null. */
  private sentAt: number | null = null;

  sent(at: number): void {
    this.sentAt = at;
  }

  /** A room answered; ignored when nothing was timed, since an unmeasured wait is not zero. */
  answered(at: number): void {
    if (this.sentAt === null) return;
    this.answers.push(at - this.sentAt);
    this.sentAt = null;
    const keep = tuning().walk.nudgeSamples;
    if (this.answers.length > keep) this.answers.splice(0, this.answers.length - keep);
  }

  /** The step will not be answered as this step: the walk ended under it. */
  abandoned(): void {
    this.sentAt = null;
  }

  /** The slowest recent answer, or null before the first. */
  get slowest(): number | null {
    return this.answers.length === 0 ? null : Math.max(...this.answers);
  }

  /** A step's usual length, or null until `walk.offRoundStepSamples` are measured. */
  get usual(): number | null {
    if (this.answers.length < tuning().walk.offRoundStepSamples) return null;
    return median(this.answers);
  }

  reset(): void {
    this.answers = [];
    this.sentAt = null;
  }
}
