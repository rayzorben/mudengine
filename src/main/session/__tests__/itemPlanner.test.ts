import { describe, expect, it } from 'vitest';

import { itemPlanner, type ItemPlannerModules } from '../itemPlanner';

/**
 * The shop trip ended once the pack holds the item (reported 2026-10-20): the
 * trip is let go and its own leg stopped, while a route the player asked for
 * is left walking.
 */
function planner(over: { trip: object | null; walking: boolean; asked: boolean }) {
  const calls: string[] = [];
  const modules = {
    supplies: {
      current: over.trip,
      abandon: (reason: string) => calls.push(`abandon:${reason}`)
    },
    walker: { walking: over.walking, stop: (reason: string) => calls.push(`stop:${reason}`) },
    travel: { walkIsAsked: over.asked }
  } as unknown as ItemPlannerModules;
  const made = itemPlanner({
    modules: () => modules,
    config: () => ({ supplies: { items: [] } }) as never,
    notice: () => {},
    stopLap: () => {}
  });
  return { made, calls };
}

describe('ending the shop trip once the pack holds the item', () => {
  it('lets the trip go and stops the leg it was walking', () => {
    const { made, calls } = planner({ trip: {}, walking: true, asked: false });
    made.stopBuying('you have rope and grapple');
    expect(calls).toEqual(['abandon:you have rope and grapple', 'stop:you have rope and grapple']);
  });

  it('leaves a route the player asked for walking', () => {
    const { made, calls } = planner({ trip: {}, walking: true, asked: true });
    made.stopBuying('got it');
    expect(calls).toEqual(['abandon:got it']);
  });

  it('stops no leg when no trip was running', () => {
    const { made, calls } = planner({ trip: null, walking: true, asked: false });
    made.stopBuying('got it');
    expect(calls).toEqual(['abandon:got it']);
  });
});
