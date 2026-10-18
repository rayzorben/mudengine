/**
 * A timing budget scaled by this worker's own speed. The full suite runs a
 * worker per thread on a hybrid laptop chip that clocks down with every core
 * busy, so the same layout ran five times slower there than alone, with CPU
 * time equal to wall time (2026-10-17: 0.64 s alone, 3.4 s in the suite). A
 * fixed reference job timed in the same worker, just before and after the
 * work, moves with whatever core and clock the worker landed on.
 */
import { median } from '../../../shared/median';

/** Builds, probes and sorts string-keyed maps, the shape of work a layout does. */
function referenceJob(rooms: number): number {
  const cells = new Map<string, number>();
  for (let i = 0; i < rooms; i++) cells.set(`${i % 997}/${i}`, i);
  let found = 0;
  for (let i = 0; i < rooms; i++) if (cells.has(`${(i * 7) % 997}/${i}`)) found++;
  const order = [...cells.values()].sort((a, b) => ((a * 31) % 1009) - ((b * 31) % 1009));
  return found + order.length;
}

const REFERENCE_ROOMS = 20_000;
/** Runs either side of the work; the median keeps one collection or preemption out of it. */
const REFERENCE_RUNS = 5;

/** Kept so the engine cannot drop a job whose result nothing reads. */
let kept = 0;

function timeReference(): number {
  const started = performance.now();
  kept += referenceJob(REFERENCE_ROOMS);
  return performance.now() - started;
}

/** How long `work` took, and the median of the reference jobs either side of it, ms. */
export function timedAgainstReference(work: () => void): { tookMs: number; referenceMs: number } {
  kept += referenceJob(REFERENCE_ROOMS);
  const runs = Array.from({ length: REFERENCE_RUNS }, timeReference);
  const started = performance.now();
  work();
  const tookMs = performance.now() - started;
  runs.push(...Array.from({ length: REFERENCE_RUNS }, timeReference));
  if (kept < 0) throw new Error('a reference job came back negative');
  return { tookMs, referenceMs: median(runs)! };
}
