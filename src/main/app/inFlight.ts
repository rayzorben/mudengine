/**
 * The reads and writes an owner started and did not wait for, so whoever
 * removes its folder (a test's teardown) can wait for the disk to go quiet
 * first. A write landing in a folder being removed failed CI with ENOTEMPTY
 * (2026-11-03).
 */
export class InFlight {
  private readonly working = new Set<Promise<unknown>>();

  /** Holds `work` until it settles, either way, and hands it back. */
  track<T>(work: Promise<T>): Promise<T> {
    this.working.add(work);
    const done = (): void => {
      this.working.delete(work);
    };
    void work.then(done, done);
    return work;
  }

  /** Resolves once nothing is in flight, including work started by work that finished meanwhile. */
  async settled(): Promise<void> {
    while (this.working.size > 0) await Promise.allSettled([...this.working]);
  }
}
