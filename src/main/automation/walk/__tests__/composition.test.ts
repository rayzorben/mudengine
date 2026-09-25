import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { methodBody } from '../../../../shared/__tests__/sources';
import { DEFAULT_INTERNAL } from '../../../../shared/internal';
import { ROUTE, at, rig } from './walking';

/*
 * How `Walker` puts down the three units it carved out in todo 740. The
 * resets are plain assignments no public answer can tell apart in any order,
 * so their order is read off the source, as `lifecycle.test.ts` reads the
 * session's; the timers are measured. Each test is red under the mutation
 * named beside it (recorded in the todo's write-up).
 */

const TUNING = DEFAULT_INTERNAL.tuning;
const WALKER = 'src/main/automation/Walker.ts';
const source = fs.readFileSync(path.resolve(WALKER), 'utf8');
const body = (declaration: RegExp): string => methodBody(source, declaration, WALKER);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the walker puts its units down', () => {
  // Mutants: the order reversed; any one of the three left out.
  it('resets them in the order their fields were cleared before the carve', () => {
    const resets = [...body(/^ {2}reset\(\): void/).matchAll(/this\.(\w+)\.reset\(\)/g)];
    expect(resets.map((call) => call[1])).toEqual(['holds', 'barriers', 'levers']);
  });

  // Mutant: stop keeps the errand.
  it('drops the lever errand when a walk stops', () => {
    expect(body(/^ {2}stop\(reason: string/)).toMatch(/this\.levers\.drop\(\)/);
  });

  // Mutant: dispose leaves the timers.
  it('leaves no timer running once disposed', () => {
    const beats = TUNING.walk.holdMs * TUNING.walk.maxHolds + 100;
    const held = rig({ holdAt: () => true, stateNow: () => at(1, 1) });
    held.walker.start(ROUTE, at(1, 1));
    const armed = vi.getTimerCount();
    held.walker.dispose();
    expect(vi.getTimerCount()).toBe(armed - 1);
    vi.advanceTimersByTime(beats);
    expect(held.sent).toEqual([]);
    held.queue.dispose();

    // Positive control: left running, the same beats end in the step.
    const running = rig({ holdAt: () => true, stateNow: () => at(1, 1) });
    running.walker.start(ROUTE, at(1, 1));
    vi.advanceTimersByTime(beats);
    expect(running.sent).toEqual(['e']);
    running.dispose();
  });
});
