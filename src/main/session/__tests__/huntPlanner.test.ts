import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER } from '../../../shared/character';
import type { Route } from '../../../shared/world';
import { huntPlanner, type HuntPlannerModules } from '../huntPlanner';

const ROUTE = { steps: [], cost: 0, blocked: false } as unknown as Route;

/** The hunt's planner over fakes: what the walker answered, and what the travel said of the run. */
function planner(answers: {
  start?: string | null;
  walking?: boolean;
  offRefused?: string | null;
}) {
  const asked: Array<{ offRounds: boolean | undefined }> = [];
  let runs = 0;
  const modules = {
    tracker: { current: EMPTY_CHARACTER, pendingMoves: 0 },
    walker: {
      start: (_route: Route, _state: unknown, leg?: { offRounds?: boolean }) => {
        asked.push({ offRounds: leg?.offRounds });
        return answers.start ?? null;
      },
      walking: answers.walking ?? true
    },
    travel: {
      startLoop: () => ({ refused: 'unused' }),
      stoppedAtStart: () => ((answers.walking ?? true) ? null : 'stopped at the start'),
      beginRun: () => {
        runs += 1;
        return answers.offRefused ?? null;
      },
      combatOnAfterRun: () => undefined
    }
  } as unknown as HuntPlannerModules;
  const hunt = huntPlanner({ modules: () => modules, stopLap: () => undefined, busy: () => false });
  return { hunt, asked, runs: () => runs };
}

describe("the hunt's walk", () => {
  it('runs timed to the rounds with combat off, and walks otherwise', () => {
    const ran = planner({});
    expect(ran.hunt.walk(ROUTE, true)).toBeNull();
    expect(ran.asked).toEqual([{ offRounds: true }]);
    expect(ran.runs()).toBe(1);
    const walked = planner({});
    expect(walked.hunt.walk(ROUTE, false)).toBeNull();
    expect(walked.runs()).toBe(0);
  });

  it('says why where the walk stopped inside its start, and turns nothing off', () => {
    const stopped = planner({ walking: false });
    expect(stopped.hunt.walk(ROUTE, true)).toBe('stopped at the start');
    expect(stopped.runs()).toBe(0);
  });

  it('is refused where the file will not take combat off', () => {
    expect(planner({ offRefused: 'no write' }).hunt.walk(ROUTE, true)).toBe('no write');
  });
});
