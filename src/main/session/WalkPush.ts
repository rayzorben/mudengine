/**
 * The walk as the window is told it: the walker's progress with the one fact
 * the walker cannot know: whether the client owes a pick-up of what it
 * stopped (`WalkProgress.pickUpOwed`, `Travel.picksUp`), and whether a step
 * back left a route behind (`routeBehind`). Those move
 * without the walk moving (a party wait taking hold after the lap's stop is
 * published), so it is read again once the stop's own handling is done, in a
 * microtask, and after every line. See `mudengine-automation` ›
 * `parts/loops.md` › *The transport stays on Stop while the client owes a
 * pick-up*.
 */
import type { WalkerProgress, WalkOwed, WalkProgress } from '../../shared/walk';
import type { SessionSink } from './SessionSink';

export class WalkPush {
  private told: WalkOwed = { pickUpOwed: false, routeBehind: false };
  private settling = false;

  constructor(
    private readonly walker: () => WalkerProgress,
    private readonly owed: () => WalkOwed,
    private readonly sink: Pick<SessionSink, 'walk'>
  ) {}

  get progress(): WalkProgress {
    return { ...this.walker(), ...this.owed() };
  }

  /** The walk moved: pushed now, and read again once whatever moved it has finished. */
  walked(): void {
    this.push();
    this.settleSoon();
  }

  /** Something that may change the owed fact ran (the lap published): read again after it. */
  settleSoon(): void {
    if (this.settling) return;
    this.settling = true;
    queueMicrotask(() => {
      this.settling = false;
      this.settle();
    });
  }

  /** Pushed again only when what the session owes changed since the last push. */
  settle(): void {
    const owed = this.owed();
    if (owed.pickUpOwed !== this.told.pickUpOwed || owed.routeBehind !== this.told.routeBehind) {
      this.push();
    }
  }

  private push(): void {
    const progress = this.progress;
    this.told = { pickUpOwed: progress.pickUpOwed, routeBehind: progress.routeBehind };
    this.sink.walk?.(progress);
  }
}
