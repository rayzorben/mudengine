import { describe, expect, it } from 'vitest';
import { plannedFetches, type Plan, type PlanStep } from '../navigation';
import type { RouteStep } from '../world';

const KEY = { id: 1, name: 'iron key' };
const BONE = { id: 2, name: 'bone key' };

function walk(count: number): PlanStep {
  const steps = Array.from({ length: count }, (_, at): RouteStep => ({
    from: `1/${at}`,
    to: `1/${at + 1}`,
    direction: 'n',
    command: 'n',
    name: 'Passage',
    requirement: null,
    dark: false
  }));
  return { kind: 'walk', route: { steps, cost: count, blocked: false } };
}

describe('the fetches of a plan', () => {
  it('counts the moves to each from where the one before it left off', () => {
    const troll = { kind: 'kill', item: KEY, monster: 'troll', room: '1/3' } as const;
    const mummy = { kind: 'kill', item: BONE, monster: 'mummy', room: '1/9' } as const;
    const plan: Plan = {
      kind: 'plan',
      steps: [walk(3), troll, walk(4), walk(2), mummy, walk(5)],
      cost: 0
    };
    expect(plannedFetches(plan)).toEqual([
      { step: troll, moves: 3 },
      { step: mummy, moves: 6 }
    ]);
  });

  it('has none in a refused plan', () => {
    expect(plannedFetches({ kind: 'refused', refusals: [] })).toEqual([]);
  });
});
