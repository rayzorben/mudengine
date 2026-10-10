/**
 * The Combat Stats card's baseline: the totals as they stood at its last reset.
 *
 * Main's tally is monotonic and the card subtracts this from it
 * (`sinceBaseline`). Three things reset it: the card's button, the lap the
 * player started being reached (`LoopEvents.lapBegun`), and a party member's
 * `@reset`. It is held in main beside the
 * totals, so a reset sent while no window is open still takes. See
 * `mudengine-automation` › *parts/remotes.md* for `@reset`.
 */
import { t } from '../app/i18n';
import { NO_BELONGINGS, type BelongingsSink } from '../../shared/belongings';
import type { CombatStatsBaseline, CombatTally } from '../../shared/tally';

type BaselineStore = Pick<BelongingsSink, 'recallStatsBase' | 'rememberStatsBase'>;

export class StatsBaseline implements CombatStatsBaseline {
  private store: BaselineStore = NO_BELONGINGS;
  /**
   * Held here as well as in the store, because a record that cannot be
   * written (suspended, or none at all) still has a card to reset this session.
   */
  private held: CombatTally | null = null;

  constructor(
    private readonly tally: () => CombatTally,
    private readonly publish: (base: CombatTally | null) => void,
    private readonly notice: (message: string) => void
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
   * The lap reaching its first stop, said with the stop: nothing on screen
   * marks the moment otherwise, and a walk out through rooms of the same name
   * reads like the loop itself (todo 20).
   */
  lapBegun(stopName: string): void {
    this.rebase();
    this.notice(t('automation.loops.statsReset', { stopName }));
  }
}
