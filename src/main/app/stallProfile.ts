/**
 * Reading a V8 `.cpuprofile` for the stretches a thread was busy without a
 * break: what a player feels as lag. Pure, so the flight recorder's summary
 * line and a test read the same arithmetic.
 *
 * A sample lasts until the next one (`timeDeltas[i + 1]`), as DevTools counts
 * it. Only `(idle)` ends a stretch: `(program)` is native work, which in a
 * window is style, layout and paint, and `(garbage collector)` blocks the
 * thread like any other work.
 */
import type { CpuProfile } from '../../shared/profiler';

/** One busy stretch: where it began in the profile, how long, and what ran. */
export interface Stall {
  /** Milliseconds from the profile's start. */
  atMs: number;
  durationMs: number;
  /** Frames by the share of the stretch's samples they were on the stack for, largest first. */
  top: Array<{ frame: string; share: number }>;
}

const BREAKS = new Set(['(idle)']);
const NOT_WORK = new Set(['(root)', '(program)', '(idle)']);

/** A frame as a summary line names it: the function, the file and the line. */
function frameLabel(callFrame: CpuProfile['nodes'][number]['callFrame']): string {
  const file = callFrame.url.split('/').slice(-2).join('/');
  const name = callFrame.functionName.length > 0 ? callFrame.functionName : '(anonymous)';
  return file.length > 0 ? `${name} ${file}:${callFrame.lineNumber + 1}` : name;
}

/** Every stretch at least `minMs` long, longest first, each with its `topN` frames. */
export function stallsIn(profile: CpuProfile, minMs: number, topN = 8): Stall[] {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parent.set(child, node.id);

  const stretches: Array<{ from: number; to: number; samples: number[] }> = [];
  let open: { from: number; to: number; samples: number[] } | null = null;
  let at = profile.startTime;
  profile.samples.forEach((sample, index) => {
    at += profile.timeDeltas[index] ?? 0;
    const lasts = profile.timeDeltas[index + 1] ?? 0;
    const name = byId.get(sample)?.callFrame.functionName ?? '';
    if (BREAKS.has(name)) {
      if (open !== null) stretches.push(open);
      open = null;
      return;
    }
    open ??= { from: at, to: at, samples: [] };
    open.to = at + lasts;
    open.samples.push(sample);
  });
  if (open !== null) stretches.push(open);

  return stretches
    .filter((stretch) => (stretch.to - stretch.from) / 1000 >= minMs)
    .sort((a, b) => b.to - b.from - (a.to - a.from))
    .map((stretch) => {
      const onStack = new Map<string, number>();
      for (const sample of stretch.samples) {
        const seen = new Set<string>();
        for (let id: number | undefined = sample; id !== undefined; id = parent.get(id)) {
          const node = byId.get(id);
          if (node === undefined || NOT_WORK.has(node.callFrame.functionName)) continue;
          const label = frameLabel(node.callFrame);
          if (seen.has(label)) continue;
          seen.add(label);
          onStack.set(label, (onStack.get(label) ?? 0) + 1);
        }
      }
      const top = [...onStack]
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([frame, count]) => ({ frame, share: count / stretch.samples.length }));
      return {
        atMs: (stretch.from - profile.startTime) / 1000,
        durationMs: (stretch.to - stretch.from) / 1000,
        top
      };
    });
}
