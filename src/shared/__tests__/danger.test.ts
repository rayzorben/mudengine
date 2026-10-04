import { describe, expect, it } from 'vitest';

import { unfoughtShare } from '../danger';
import type { Survival } from '../survival';

const fight = (survives: number): Survival => ({ survives }) as unknown as Survival;

describe('the danger a fight is', () => {
  it('prices a fight under the line, leaves one nobody can run unpriced, and waits on one still being run', () => {
    const run = (survives: number) => ({ kind: 'run' as const, survival: fight(survives) });
    expect(unfoughtShare(run(0.4), 0.95)).toBe(0.4);
    expect(unfoughtShare(run(0.99), 0.95)).toBeUndefined();
    expect(unfoughtShare({ kind: 'unrun' }, 0.95)).toBeUndefined();
    expect(unfoughtShare({ kind: 'pending' }, 0.95)).toBeNull();
    expect(unfoughtShare({ kind: 'unread' }, 0.95)).toBeNull();
    expect(unfoughtShare({ kind: 'pending' }, 0)).toBeUndefined();
  });
});
