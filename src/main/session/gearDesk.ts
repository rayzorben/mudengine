/**
 * What the Gear card asks of a session: the slots read (`gearReads`), the
 * realm's bless items not carried (`blessItems`, todo 44), a trip
 * planned for the items picked (`planGearTrip`), and that trip walked or run
 * (`GearTrip`). A press plans again from where the character stands, never
 * walking the plan the card was shown, and turns automation on as a route the
 * player asked for does (`Travel.switchedOnFor`).
 */
import type { GearTrip } from '../automation/GearTrip';
import type { GearPick, GearTripPlan, GearTripProgress } from '../../shared/gearTrip';
import type { BlessItem } from '../../shared/blessItems';
import type { GearConfig } from '../../shared/config';
import type { GearChoices } from '../../shared/upgrades';
import { blessItems } from '../world/blessItems';
import { dropsIn, gearRealmOf, gearReads, type GearReadParts, type GearReads } from './gearReads';
import { planGearTrip, type GearPlanParts } from './gearTripPlan';
import type { Travel } from './Travel';

export interface GearDeskParts extends GearReadParts {
  /** The weighing settings, what the card offers a slot and the trip's cash buffer. */
  config(): ReturnType<GearReadParts['config']> &
    ReturnType<GearPlanParts['config']> & { gear: Pick<GearConfig, 'offersPerSlot'> };
  errands: GearReadParts['errands'] & GearPlanParts['errands'];
  world(): ReturnType<GearReadParts['world']> & ReturnType<GearPlanParts['world']>;
  trip(): Pick<GearTrip, 'start' | 'stop' | 'progress'>;
  travel(): Pick<Travel, 'switchedOnFor'>;
}

export interface GearDesk {
  /** The reads an extension is handed too. */
  readonly reads: GearReads;
  choices(): GearChoices;
  /** The Bless Items face; null while the realm, the room or the level is unread. */
  blessItems(): BlessItem[] | null;
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
    choices: () => reads.choices(parts.config().gear.offersPerSlot),
    blessItems: () => {
      const state = parts.tracker.current;
      const world = parts.world();
      const realm = world === undefined ? null : gearRealmOf(state, world, parts.errands);
      if (world === undefined || realm === null) return null;
      return blessItems(state, {
        ...realm,
        itemsWhere: (test) => world.itemsWhere(test),
        spellById: (id) => world.spellById(id),
        dropsOf: dropsIn(world)
      });
    },
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
