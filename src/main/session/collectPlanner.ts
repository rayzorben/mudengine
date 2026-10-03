/**
 * What the two trips that take items off a room's floor are handed (todo 05):
 * going back for the gear after a death (`GearRecovery`) and fetching from a
 * stash (`StashFetch`). One walk and one pick-up (`Collect`), so one planner:
 * routes from here through the navigation engine, the walker as a leg, the
 * realm's coin word, and for the stash fetch the lap it holds. Out of
 * `SessionManager`'s constructor whole, as `outgrownPlanner.ts` is.
 */
import type { CommandQueue } from '../automation/CommandQueue';
import {
  GearRecovery,
  type RecoveryEvents,
  type RecoveryPlanner
} from '../automation/GearRecovery';
import { StashFetch, type StashFetchEvents } from '../automation/StashFetch';
import type { AutomationConfig } from '../../shared/config';
import { legPlanner, type LegModules, type LegPlanner } from './legPlanner';
import type { Vocabulary } from './Vocabulary';

/** The leg's modules, and the realm's coin words. */
export interface CollectModules extends LegModules {
  vocabulary: Pick<Vocabulary, 'coins'>;
}

export interface CollectParts {
  modules(): CollectModules;
  /** An escape, or for the stash fetch another trip, has the character. */
  busy(): boolean;
  /** The lap given back once the stash fetch is over. */
  release(): void;
}

function collectPlanner(parts: CollectParts): RecoveryPlanner & LegPlanner {
  return {
    ...legPlanner(parts.modules),
    coinWord: (coin) => parts.modules().vocabulary.coins.word(coin),
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
