/**
 * What is kept for a character as it stands: values that hold while the
 * realm, the tuning and what decides a way (a reach key) are the same, and
 * are all dropped when any of the three moves. `Navigation.withinNow` keeps
 * its sweeps under one and `Errands.standsOnLeg` its lap legs.
 */
import { tuning } from '../app/tuning';

interface Kept<V> {
  world: object;
  tuning: object;
  key: string;
  values: Map<string, V>;
}

export class KeptUnder<V> {
  private kept: Kept<V> | null = null;

  /** `cap` is how many values are held before all are dropped for the next. */
  constructor(private readonly cap: () => number) {}

  /** The values kept for `world`, `tuning()` and `key`; none once one of the three has moved. */
  under(world: object, key: string): ReadonlyMap<string, V> {
    const now = tuning();
    let kept = this.kept;
    if (kept === null || kept.world !== world || kept.tuning !== now || kept.key !== key) {
      kept = { world, tuning: now, key, values: new Map() };
      this.kept = kept;
    }
    return kept.values;
  }

  /** Keeps `value` at `at` under what `under` was last asked for; true when the full set was dropped for it. */
  keep(at: string, value: V): boolean {
    const values = this.kept?.values;
    if (values === undefined) return false;
    const dropped = values.size >= this.cap();
    if (dropped) values.clear();
    values.set(at, value);
    return dropped;
  }

  /** Lets one kept value go. */
  drop(at: string): void {
    this.kept?.values.delete(at);
  }
}
