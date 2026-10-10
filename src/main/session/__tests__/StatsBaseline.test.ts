import { describe, expect, it } from 'vitest';

import { t } from '../../app/i18n';
import { StatsBaseline } from '../StatsBaseline';
import { NO_TALLY, type CombatTally } from '../../../shared/tally';

function harness(stored: CombatTally | null = null) {
  let tally: CombatTally = { ...NO_TALLY, since: 1_000, kills: 2 };
  const record = { stored };
  const published: Array<number | null> = [];
  const said: string[] = [];
  const baseline = new StatsBaseline(
    () => tally,
    (base) => published.push(base === null ? null : base.kills),
    (message) => said.push(message)
  );
  const store = {
    recallStatsBase: () => record.stored,
    rememberStatsBase: (base: CombatTally) => {
      record.stored = base;
    }
  };
  return {
    baseline,
    store,
    record,
    published,
    said,
    kill: () => {
      tally = { ...tally, kills: (tally.kills ?? 0) + 1 };
    }
  };
}

describe('the Combat Stats baseline', () => {
  it('reads each record it is given, and pushes what it read, never reset included', () => {
    const { baseline, store, published } = harness({ ...NO_TALLY, kills: 7 });
    expect(baseline.base).toBeNull();
    baseline.useStore(store);
    expect(baseline.base?.kills).toBe(7);
    baseline.useStore({ recallStatsBase: () => null, rememberStatsBase: () => {} });
    expect(baseline.base).toBeNull();
    expect(published).toEqual([7, null]);
  });

  it('keeps and pushes the totals as they stand on a reset', () => {
    const { baseline, store, record, published, kill } = harness();
    baseline.useStore(store);
    kill();
    baseline.rebase();
    expect(baseline.base?.kills).toBe(3);
    expect(record.stored?.kills).toBe(3);
    expect(published).toEqual([null, 3]);
  });

  it('resets on the lap reaching its first stop, and says so with the stop', () => {
    const { baseline, store, published, said, kill } = harness();
    baseline.useStore(store);
    kill();
    baseline.lapBegun('Stonework Tunnel');
    expect(published).toEqual([null, 3]);
    expect(said).toEqual([t('automation.loops.statsReset', { stopName: 'Stonework Tunnel' })]);
  });

  it('holds a reset for the session when the record keeps nothing', () => {
    const { baseline } = harness();
    baseline.rebase();
    expect(baseline.base?.kills).toBe(2);
  });
});
