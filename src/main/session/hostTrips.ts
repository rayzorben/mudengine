/**
 * The trips only an extension starts, through the host: a fetch from a room
 * (`StashFetch`) and a sale at a counter (`SellTrip`). The client decides
 * neither; it walks, searches, takes, sells and says how each ended. One
 * module to the session, so the walk's end, the pack and a death reach both.
 */
import type { CommandQueue } from '../automation/CommandQueue';
import type { SessionModule } from '../automation/Module';
import { SellTrip, type SellTripEvents } from '../automation/SellTrip';
import type { StashFetch, StashFetchEvents } from '../automation/StashFetch';
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import type { WorldGraph } from '../world/WorldGraph';
import { stashFetchTrip, type CollectModules, type CollectParts } from './collectPlanner';
import { legPlanner } from './legPlanner';
import { counterIn } from '../../shared/world';

export class HostTrips implements SessionModule {
  constructor(
    readonly stash: StashFetch,
    readonly sell: SellTrip
  ) {}

  get busy(): boolean {
    return this.stash.busy || this.sell.busy;
  }

  configure(enabled: boolean): void {
    this.stash.configure(enabled);
    this.sell.configure(enabled);
  }

  reset(): void {
    this.stash.reset();
    this.sell.reset();
  }

  /** A death: wherever either was going is somewhere else now. */
  abandon(): void {
    this.stash.abandon();
    this.sell.abandon();
  }

  onBlock(block: Block): void {
    this.stash.onBlock(block);
  }

  onCharacter(state: CharacterState): void {
    this.stash.onCharacter(state);
    this.sell.onCharacter(state);
  }

  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    this.stash.onWalkEnded(arrived, reason, state);
    this.sell.onWalkEnded(arrived, reason, state);
  }
}

/** The collect trips' modules, and the realm's counters for naming the one a sale walks to. */
export interface HostTripParts extends CollectParts {
  modules(): CollectModules & { world: Pick<WorldGraph, 'byId' | 'shop'> | undefined };
}

/** Both trips, holding the lap while either runs. */
export function hostTrips(
  automation: AutomationConfig,
  queue: CommandQueue,
  events: StashFetchEvents & SellTripEvents,
  parts: HostTripParts
): HostTrips {
  const sell = new SellTrip(
    automation.enabled,
    queue,
    {
      ...legPlanner(parts.modules),
      counterIn: (room) => {
        const { world } = parts.modules();
        const place = world?.byId(room);
        return place === undefined
          ? null
          : (counterIn(place, (id) => world?.shop(id))?.shop ?? null);
      },
      busy: parts.busy,
      release: parts.release
    },
    events
  );
  return new HostTrips(stashFetchTrip(automation, queue, events, parts), sell);
}
