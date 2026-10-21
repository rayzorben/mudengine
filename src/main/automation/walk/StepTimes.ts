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
import { AnswerTimes } from '../../../shared/answerTimes';

export class StepTimes {
  private readonly answers = new AnswerTimes();
  /** When the step outstanding reached the wire, or null. */
  private sentAt: number | null = null;

  sent(at: number): void {
    this.sentAt = at;
  }

  /** A room answered; ignored when nothing was timed, since an unmeasured wait is not zero. */
  answered(at: number): void {
    if (this.sentAt === null) return;
    this.answers.record(at - this.sentAt, tuning().walk.nudgeSamples);
    this.sentAt = null;
  }

  /** The step will not be answered as this step: the walk ended under it. */
  abandoned(): void {
    this.sentAt = null;
  }

  /** The nudge's deadline: `AnswerTimes.after`, over the walk's own answers. */
  after(margin: number, floor: number, ceiling: number): number {
    return this.answers.after(margin, floor, ceiling);
  }

  /** A step's usual length, or null until `walk.offRoundStepSamples` are measured. */
  get usual(): number | null {
    return this.answers.usual(tuning().walk.offRoundStepSamples);
  }

  reset(): void {
    this.answers.reset();
    this.sentAt = null;
  }
}
