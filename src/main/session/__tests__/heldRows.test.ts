import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { setTuning } from '../../app/tuning';
import { HeldRows } from '../heldRows';

/*
 * The batching `FightLog` and `HarmLog` share (todo 26): one timer, held
 * rows kept while the writer may not write yet, a failure said once.
 */
describe('rows held and written in batches', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setTuning(DEFAULT_INTERNAL.tuning);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes what is held once the timer runs, in one batch', () => {
    const wrote: number[][] = [];
    const rows = new HeldRows<number>({
      dir: 'x',
      write: (batch) => (wrote.push([...batch]), true)
    });
    rows.hold(1);
    rows.hold(2);
    expect(wrote).toEqual([]);
    vi.advanceTimersByTime(DEFAULT_INTERNAL.tuning.records.fightFlushMs);
    expect(wrote).toEqual([[1, 2]]);
  });

  it('keeps the rows while the writer may not write yet, and writes them on the way out', () => {
    const wrote: number[][] = [];
    const rows = new HeldRows<number>({
      dir: 'x',
      write: (batch, final) => (final ? (wrote.push([...batch]), true) : false)
    });
    rows.hold(1);
    vi.advanceTimersByTime(DEFAULT_INTERNAL.tuning.records.fightFlushMs);
    expect(wrote).toEqual([]);
    rows.hold(2);
    rows.flush();
    expect(wrote).toEqual([[1, 2]]);
  });

  it('says a write that throws once, and does not retry the rows', () => {
    const notice = vi.fn();
    let calls = 0;
    const rows = new HeldRows<number>({
      dir: 'x',
      write: () => {
        calls += 1;
        throw new Error('read-only');
      },
      notice
    });
    rows.hold(1);
    rows.flush();
    rows.hold(2);
    rows.flush();
    rows.flush();
    expect(calls).toBe(2);
    expect(notice).toHaveBeenCalledTimes(1);
  });
});
