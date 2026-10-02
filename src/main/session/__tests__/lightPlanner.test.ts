import { describe, expect, it } from 'vitest';

import { lightPlanner, type LightPlannerModules } from '../lightPlanner';
import { EMPTY_CHARACTER } from '../../../shared/character';
import type { Route, RouteStep } from '../../../shared/world';

const leg = (from: string, to: string): Route =>
  ({ steps: [{ from, to } as RouteStep], cost: 1, blocked: false }) as Route;

function planner(legs: string[]) {
  const modules = {
    tracker: { current: EMPTY_CHARACTER },
    errands: {
      travellerNow: () => ({}),
      stopRoom: (stop: { name: string }) => (stop.name === 'Nowhere' ? null : stop.name),
      routeBetween: (from: string, to: string) => {
        legs.push(`${from}>${to}`);
        return from === '1/3' ? 'no route' : leg(from, to);
      }
    },
    itemErrand: { collect: () => null, running: false },
    world: undefined
  } as unknown as LightPlannerModules;
  return lightPlanner(() => modules);
}

describe("one lap's steps", () => {
  it('walks stop to stop and back round, leaving out a stop or a leg that will not plan', () => {
    const legs: string[] = [];
    const steps = planner(legs).lapSteps({
      name: 'crypt',
      stops: [{ room: '1/1' }, { room: 'Nowhere' }, { room: '1/2' }, { room: '1/3' }]
    });
    expect(legs).toEqual(['1/2>1/3', '1/3>1/1']);
    expect(steps.map((step) => step.to)).toEqual(['1/3']);
  });

  it('walks a bouncing lap there and back, as the runner does', () => {
    const legs: string[] = [];
    planner(legs).lapSteps({
      name: 'hall',
      bounce: true,
      stops: [{ room: '1/1' }, { room: '1/2' }, { room: '1/4' }]
    });
    expect(legs).toEqual(['1/1>1/2', '1/2>1/4', '1/4>1/2', '1/2>1/1']);
  });

  it('has no counters with nowhere to stand', () => {
    expect(planner([]).counters([175], null)).toEqual([]);
  });
});
