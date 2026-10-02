import { describe, expect, it } from 'vitest';

import type { CpuProfile } from '../../../shared/profiler';
import { stallsIn } from '../stallProfile';

/** A profile from a list of (node, ms) samples over a fixed tree: root → idle | work → slow. */
function profile(samples: Array<[number, number]>): CpuProfile {
  const frame = (functionName: string, url = '', lineNumber = 0) => ({
    functionName,
    url,
    lineNumber
  });
  return {
    nodes: [
      { id: 1, callFrame: frame('(root)'), children: [2, 3, 5] },
      { id: 2, callFrame: frame('(idle)') },
      { id: 3, callFrame: frame('onLine', 'file:///x/src/SessionManager.ts', 9), children: [4] },
      { id: 4, callFrame: frame('route', 'file:///x/src/Router.ts', 41) },
      { id: 5, callFrame: frame('(garbage collector)') }
    ],
    startTime: 0,
    endTime: samples.reduce((sum, [, ms]) => sum + ms * 1000, 0),
    samples: samples.map(([node]) => node),
    timeDeltas: samples.map(([, ms]) => ms * 1000)
  };
}

describe('the busy stretches in a profile', () => {
  it('finds a stretch without a break as long as the threshold, with what ran in it', () => {
    const stalls = stallsIn(
      profile([
        [2, 5],
        [3, 100],
        [4, 100],
        [4, 100],
        [5, 100],
        [2, 5]
      ]),
      250
    );
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.atMs).toBe(105);
    expect(stalls[0]!.durationMs).toBe(305);
    expect(stalls[0]!.top[0]).toEqual({ frame: 'onLine src/SessionManager.ts:10', share: 0.75 });
    expect(stalls[0]!.top).toContainEqual({ frame: 'route src/Router.ts:42', share: 0.5 });
  });

  it('keeps nothing where idle breaks the work into short stretches', () => {
    const stalls = stallsIn(
      profile([
        [3, 100],
        [2, 5],
        [3, 100],
        [2, 5],
        [3, 100],
        [2, 5]
      ]),
      250
    );
    expect(stalls).toEqual([]);
  });
});
