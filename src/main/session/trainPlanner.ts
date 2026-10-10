/**
 * What the trip to collect a level (`TrainErrand`, todo 18) is handed: the
 * trainers the realm lists, routes from here, the walker, the lap it holds,
 * the item errand that fetches a key a trainer's door wants or a light its
 * dark rooms do, and the reward the trainer's room puts out for this class.
 * Out of `SessionManager`'s constructor whole, so the session composes it in
 * one call.
 */
import type { ItemErrand } from '../automation/ItemErrand';
import type { LightAhead } from '../automation/LightAhead';
import type { CommandQueue } from '../automation/CommandQueue';
import { TrainErrand, type TrainEvents, type TrainPlanner } from '../automation/TrainErrand';
import type { WorldGraph } from '../world/WorldGraph';
import { wearerOf } from '../world/wearer';
import type { AutomationConfig } from '../../shared/config';
import { carriedCount } from '../../shared/supplies';
import { trainerPrize, type PlacedItem } from '../../shared/training';
import type { Errands } from './Errands';
import { legPlanner, type LegModules } from './legPlanner';
import type { Travel } from './Travel';

/** The modules, read when the errand asks: several are built after it. */
export interface TrainPlannerModules extends LegModules {
  errands: Pick<Errands, 'trainers' | 'planTo' | 'planFromHere'>;
  travel: Pick<Travel, 'escaping'>;
  itemErrand: Pick<ItemErrand, 'collect' | 'running'>;
  light: Pick<LightAhead, 'wanted' | 'settle'>;
  world:
    | Pick<WorldGraph, 'byId' | 'item' | 'classNamed' | 'raceId' | 'namedClasses' | 'namedRaces'>
    | undefined;
}

export interface TrainPlannerParts {
  modules(): TrainPlannerModules;
  /** The lap given back once the errand is over. */
  release(): void;
}

export function trainPlanner(parts: TrainPlannerParts): TrainPlanner {
  const m = parts.modules;
  return {
    ...legPlanner(m),
    trainers: (level) => m().errands.trainers(level),
    plan: (room) => m().errands.planTo(room),
    fetch: (items, then) => m().itemErrand.collect(items, then, m().tracker.current),
    fetching: () => m().itemErrand.running,
    lightFor: (route) => m().light.wanted(route, m().tracker.current),
    lightSettled: (light, refused) => m().light.settle(light, refused),
    prize: (room) => {
      const world = m().world;
      const state = m().tracker.current;
      if (world === undefined) return null;
      const placed = (world.byId(room)?.placed ?? []).flatMap((id): PlacedItem[] => {
        const item = world.item(id);
        return item === undefined ? [] : [item];
      });
      const prize = trainerPrize(placed, wearerOf(state, world));
      return prize === null || carriedCount(state, prize.name) > 0 ? null : { name: prize.name };
    },
    busy: () => m().travel.escaping,
    release: parts.release
  };
}

/** The errand with its planner, composed in one call as `gearRecoveryTrip` is. */
export function trainTrip(
  automation: AutomationConfig,
  queue: CommandQueue,
  events: TrainEvents,
  parts: TrainPlannerParts
): TrainErrand {
  return new TrainErrand(automation.train, automation.enabled, queue, trainPlanner(parts), events);
}
