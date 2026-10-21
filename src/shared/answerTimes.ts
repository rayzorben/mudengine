/**
 * The last few times a realm took to answer something, and the slowest and
 * usual of them. One window for the walk's step deadline (`walk/StepTimes.ts`)
 * and the claim queue's probe clock (`parse/expectations.ts`): both nudge or
 * probe after this realm's own slowest recent answer. The caller passes the
 * window's depth, since `src/shared/` cannot read `internal.yaml`.
 */
import { median } from './median';

export class AnswerTimes {
  private answers: number[] = [];

  /** One more answer, keeping the last `keep` so one lagged answer ages out. */
  record(ms: number, keep: number): void {
    this.answers.push(ms);
    if (this.answers.length > keep) this.answers.splice(0, this.answers.length - keep);
  }

  /** The slowest recent answer, or null before the first. */
  get slowest(): number | null {
    return this.answers.length === 0 ? null : Math.max(...this.answers);
  }

  /**
   * A deadline over the slowest answer: `margin` on top of it, never under
   * `floor` nor past `ceiling`, and `floor` alone before anything was
   * measured. The walk's nudge and the claim queue's probe are both this.
   */
  after(margin: number, floor: number, ceiling: number): number {
    const slowest = this.slowest;
    if (slowest === null) return floor;
    return Math.min(Math.max(floor, slowest + margin), ceiling);
  }

  /** The usual answer, or null until `atLeast` are measured. */
  usual(atLeast: number): number | null {
    if (this.answers.length < atLeast) return null;
    return median(this.answers);
  }

  reset(): void {
    this.answers = [];
  }
}
