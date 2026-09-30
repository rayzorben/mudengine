/**
 * The Combat Stats card's baseline: the totals as they stood at its last reset.
 *
 * Main's tally is monotonic and the card subtracts this from it
 * (`sinceBaseline`). Three things reset it: the card's button, a lap
 * beginning, and a party member's `@reset`. It is held in main beside the
 * totals, so a reset sent while no window is open still takes. See
 * `mudengine-automation` › *parts/remotes.md* for `@reset`.
 */
import { NO_BELONGINGS, type BelongingsSink } from '../../shared/belongings';
import type { LoopProgress } from '../../shared/loops';
import type { CombatStatsBaseline, CombatTally } from '../../shared/tally';

type BaselineStore = Pick<BelongingsSink, 'recallStatsBase' | 'rememberStatsBase'>;

export class StatsBaseline implements CombatStatsBaseline {
  private store: BaselineStore = NO_BELONGINGS;
  /**
   * Held here as well as in the store, because a record that cannot be
   * written (suspended, or none at all) still has a card to reset this session.
   */
  private held: CombatTally | null = null;
  /** The lap last seen, so a restart of the same run re-bases nothing. */
  private lapBegunAt: number | null = null;

  constructor(
    private readonly tally: () => CombatTally,
    private readonly publish: (base: CombatTally | null) => void
  ) {}

  get base(): CombatTally | null {
    return this.held;
  }

  /** The character's record, on each realm dialled and after it is forgotten. */
  useStore(store: BaselineStore): void {
    this.store = store;
    this.held = store.recallStatsBase();
    this.publish(this.held);
  }

  rebase(): void {
    this.held = this.tally();
    this.store.rememberStatsBase(this.held);
    this.publish(this.held);
  }

  /**
   * *"Starting a loop should reset combat statistics; restarting a loop should
   * not."* `lapBegunAt` is set once per run at the first stop reached, and a
   * `resume` leaves it alone, so both halves are one test.
   */
  noteLap(progress: LoopProgress): void {
    const begun = progress.lapBegunAt;
    if (begun !== null && begun !== this.lapBegunAt) this.rebase();
    this.lapBegunAt = begun;
  }
}
