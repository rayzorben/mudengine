/**
 * What the Sell face's run is handed (`SellRun`): the leg every trip shares,
 * the rows and the plan from where the character stands (`sellRunPlan.ts`),
 * automation turned on for a run the player asked for (`Travel.switchedOnFor`)
 * and the leg stopped with the run. Beside `hostTrips.ts`, which composes it.
 */
import type { SellRunPlanner } from '../automation/SellRun';
import type { Walker } from '../automation/Walker';
import type { QuestKeep } from '../../shared/questKeep';
import { legPlanner, stopErrandLeg, type LegModules } from './legPlanner';
import { planRounds, planSellRun, sellChoices, type SellPlanParts } from './sellRunPlan';
import type { Travel } from './Travel';

export interface SellDeskParts {
  modules(): LegModules & {
    world: ReturnType<SellPlanParts['world']>;
    errands: LegModules['errands'] & SellPlanParts['errands'];
    walker: LegModules['walker'] & Pick<Walker, 'stop'>;
    travel: Pick<Travel, 'escaping' | 'switchedOnFor' | 'walkIsAsked'>;
  };
  /** An escape or another trip has the character. */
  busy(): boolean;
  /** The lap given back once the run is over. */
  release(): void;
  /** What an unfinished quest still needs (todo 52). */
  kept: QuestKeep;
}

export function sellRunPlanner(parts: SellDeskParts): SellRunPlanner {
  const m = parts.modules;
  const planning: SellPlanParts = {
    world: () => m().world,
    get errands() {
      return m().errands;
    },
    state: () => m().tracker.current,
    kept: parts.kept
  };
  return {
    ...legPlanner(m),
    current: () => m().tracker.current,
    busy: parts.busy,
    release: parts.release,
    escaping: () => m().travel.escaping,
    choices: () => sellChoices(planning),
    plan: (picks) => planSellRun(planning, picks),
    again: (floor, room) => planRounds(planning, [], floor, room),
    switchedOnFor: (start) => m().travel.switchedOnFor(start),
    stopWalk: (reason) => stopErrandLeg(m(), reason)
  };
}
