/**
 * What the Gear card asks of a session: the slots read (`gearReads`), a trip
 * planned for the items picked (`planGearTrip`), and that trip walked or run
 * (`GearTrip`). A press plans again from where the character stands, never
 * walking the plan the card was shown, and turns automation on as a route the
 * player asked for does (`Travel.switchedOnFor`).
 */
import { tuning } from '../app/tuning';
import type { GearTrip } from '../automation/GearTrip';
import type { GearPick, GearTripPlan, GearTripProgress } from '../../shared/gearTrip';
import type { GearChoices } from '../../shared/upgrades';
import { gearReads, type GearReadParts, type GearReads } from './gearReads';
import { planGearTrip, type GearPlanParts } from './gearTripPlan';
import type { Travel } from './Travel';

export interface GearDeskParts extends GearReadParts {
  errands: GearReadParts['errands'] & GearPlanParts['errands'];
  world(): ReturnType<GearReadParts['world']> & ReturnType<GearPlanParts['world']>;
  trip(): Pick<GearTrip, 'start' | 'stop' | 'progress'>;
  travel(): Pick<Travel, 'switchedOnFor'>;
}

export interface GearDesk {
  /** The reads an extension is handed too. */
  readonly reads: GearReads;
  choices(): GearChoices;
  plan(picks: readonly GearPick[]): Promise<GearTripPlan>;
  /** The trip from here, walked or run; its refusal, or null once under way. */
  go(picks: readonly GearPick[], run: boolean): Promise<string | null>;
  stop(): void;
  readonly progress: GearTripProgress | null;
}

export function gearDesk(parts: GearDeskParts): GearDesk {
  const reads = gearReads(parts);
  const planning: GearPlanParts = { ...parts, state: () => parts.tracker.current };
  return {
    reads,
    choices: () => reads.choices(tuning().gear.perSlot),
    plan: (picks) => planGearTrip(planning, picks),
    go: async (picks, run) => {
      const plan = await planGearTrip(planning, picks);
      if (plan.refusal !== undefined) return plan.refusal;
      return parts
        .travel()
        .switchedOnFor(() => parts.trip().start(plan, run, parts.tracker.current));
    },
    stop: () => parts.trip().stop(),
    get progress() {
      return parts.trip().progress;
    }
  };
}
