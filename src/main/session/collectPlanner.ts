/**
 * What the trips built on `Collect` are handed: going back for the gear after
 * a death (`GearRecovery`), fetching from a stash (`StashFetch`, both todo 05)
 * and searching the area (`AreaSearch`). One walk and its searches, so one
 * planner: routes from here through the navigation engine, the walker as a
 * leg, the realm's coin word, whether a fight holds a search, and for the
 * stash fetch the lap it holds. Out of `SessionManager`'s constructor whole,
 * as `outgrownPlanner.ts` is.
 */
import { AreaSearch, type AreaSearchEvents } from '../automation/AreaSearch';
import type { AutoCombat } from '../automation/AutoCombat';
import type { AutoLoot } from '../automation/AutoLoot';
import type { CommandQueue } from '../automation/CommandQueue';
import {
  GearRecovery,
  type RecoveryEvents,
  type RecoveryPlanner
} from '../automation/GearRecovery';
import { StashFetch, type StashFetchEvents } from '../automation/StashFetch';
import { t } from '../app/i18n';
import { fightIsRunning } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import type { WorldGraph } from '../world/WorldGraph';
import { planArea } from './areaPlan';
import type { Errands } from './Errands';
import { legPlanner, type LegModules, type LegPlanner } from './legPlanner';
import { ERRAND_LEG, type Travel } from './Travel';
import type { Vocabulary } from './Vocabulary';

/** The leg's modules, the realm's coin words, and what holds a search or a walk on. */
export interface CollectModules extends LegModules {
  vocabulary: Pick<Vocabulary, 'coins'>;
  combat: Pick<AutoCombat, 'quarry' | 'willFight'>;
  loot: Pick<AutoLoot, 'taking'>;
  errands: LegModules['errands'] & Pick<Errands, 'tripReach' | 'monstersIn'>;
  world: Pick<WorldGraph, 'byId'> | undefined;
  travel: Pick<Travel, 'escaping'>;
}

export interface CollectParts {
  modules(): CollectModules;
  /** An escape, or for the stash fetch another trip, has the character. */
  busy(): boolean;
  /** The lap given back once the stash fetch is over. */
  release(): void;
}

function collectPlanner(
  parts: CollectParts
): RecoveryPlanner & LegPlanner & { fighting(): boolean } {
  const fighting = (): boolean => {
    const { tracker, combat } = parts.modules();
    return fightIsRunning(tracker.current) || combat.quarry(tracker.current);
  };
  return {
    ...legPlanner(parts.modules),
    coinWord: (coin) => parts.modules().vocabulary.coins.word(coin),
    fighting,
    busy: parts.busy
  };
}

/** The gear after a death: a leg back, holding when hurt, fighting nothing on the way. */
export function gearRecoveryTrip(
  automation: AutomationConfig,
  queue: CommandQueue,
  events: RecoveryEvents,
  parts: CollectParts
): GearRecovery {
  return new GearRecovery(
    automation.movement,
    automation.enabled,
    queue,
    collectPlanner(parts),
    events
  );
}

/** A fetch from a stash, started by an extension, holding the lap while it runs. */
export function stashFetchTrip(
  automation: AutomationConfig,
  queue: CommandQueue,
  events: StashFetchEvents,
  parts: CollectParts
): StashFetch {
  return new StashFetch(
    automation.enabled,
    queue,
    { ...collectPlanner(parts), release: parts.release },
    events
  );
}

const AREA_LEG = { ...ERRAND_LEG, quiet: true, resumeAfterFight: false } as const;

/** A search of every room near the character, asked for by the player. */
export function areaSearchTrip(
  automation: AutomationConfig,
  queue: CommandQueue,
  events: AreaSearchEvents,
  parts: CollectParts
): AreaSearch {
  const planner = collectPlanner(parts);
  const m = parts.modules;
  return new AreaSearch(
    automation.enabled,
    queue,
    {
      ...planner,
      /*
       * Unsaid: the room searched is the line, and a walk said per room is
       * hundreds. Not picked up after a fight, since the walker's own plan
       * would not keep out of the walled rooms: `AreaSearch` plans it again.
       */
      walk: (route) => m().walker.start(route, m().tracker.current, AREA_LEG),
      routeAround: (room, walled) =>
        m().errands.tripReach(walled)?.leg(room) ?? t('session.loop.noRealmData'),
      fightsBack: () => m().combat.willFight,
      plan: (radius) => planArea({ here: planner.here, errands: m().errands }, radius),
      nameOf: (room) => m().world?.byId(room)?.name ?? room,
      escaping: () => m().travel.escaping,
      taking: () => m().loot.taking()
    },
    events
  );
}
