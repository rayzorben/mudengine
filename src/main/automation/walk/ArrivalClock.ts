/**
 * When a walk is expected to end, projected at each confirmed step from the
 * average a step has taken since the walk began, fights and holds on the way
 * included. The window counts down to it (`WalkProgress.arrivalAt`). Replayed
 * over eleven shop trips the figure was within half the true time on 73% of
 * steps and low in the median, a few slow steps pulling the true time up; on
 * a long walk it settles within a tenth. The figures are in
 * `mudengine-automation` › decisions.md under *The walk's clocks*.
 */
export class ArrivalClock {
  private startedAt: number | null = null;
  private steppedAt: number | null = null;

  /** A walk begins: nothing is known of its pace yet, whatever the last walk's was. */
  begin(now: number): void {
    this.startedAt = now;
    this.steppedAt = now;
  }

  /** A step was confirmed, so the average and the anchor move on. */
  stepped(now: number): void {
    this.steppedAt = now;
  }

  /**
   * When the walk should end, or null before the first step is confirmed or
   * with no step left. `done` are the journey's confirmed steps and `left`
   * the ones still to walk, so a plan redrawn after a fight projects from
   * the same average over its new length.
   */
  arrivalAt(done: number, left: number): number | null {
    if (this.startedAt === null || this.steppedAt === null || done <= 0 || left <= 0) return null;
    return this.steppedAt + ((this.steppedAt - this.startedAt) / done) * left;
  }
}
