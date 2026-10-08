/**
 * The trips the client walks on request: a fetch from a room (`StashFetch`)
 * and a sale at a counter (`SellTrip`), which only an extension starts, and a
 * gear trip (`GearTrip`), which the player starts from the Gear card. The
 * client decides none of them; it walks, searches, takes, buys, sells and says
 * how each ended. One module to the session, so the walk's end, the pack and a
 * death reach every one.
 */
import type { CommandQueue } from '../automation/CommandQueue';
import type { SessionModule } from '../automation/Module';
import { GearTrip, type GearTripEvents } from '../automation/GearTrip';
import { SellTrip, type SellTripEvents } from '../automation/SellTrip';
import type { StashFetch, StashFetchEvents } from '../automation/StashFetch';
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import type { WorldGraph } from '../world/WorldGraph';
import { stashFetchTrip, type CollectModules, type CollectParts } from './collectPlanner';
import { legPlanner } from './legPlanner';
import { wearPlan } from '../../shared/gear';
import { counterIn } from '../../shared/world';
import type { Travel } from './Travel';
import { ERRAND_LEG } from './Travel';

export class HostTrips implements SessionModule {
  constructor(
    readonly stash: StashFetch,
    readonly sell: SellTrip,
    readonly gear: GearTrip
  ) {}

  get busy(): boolean {
    return this.stash.busy || this.sell.busy || this.gear.busy;
  }

  configure(enabled: boolean): void {
    for (const trip of this.trips) trip.configure(enabled);
  }

  reset(): void {
    for (const trip of this.trips) trip.reset();
  }

  /** A death: wherever any was going is somewhere else now. */
  abandon(): void {
    for (const trip of this.trips) trip.abandon();
  }

  onBlock(block: Block): void {
    this.stash.onBlock(block);
    this.gear.onBlock(block);
  }

  onCharacter(state: CharacterState): void {
    for (const trip of this.trips) trip.onCharacter(state);
  }

  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    for (const trip of this.trips) trip.onWalkEnded(arrived, reason, state);
  }

  private get trips(): ReadonlyArray<StashFetch | SellTrip | GearTrip> {
    return [this.stash, this.sell, this.gear];
  }
}

/** The collect trips' modules, and the realm's counters for naming the one a sale walks to. */
export interface HostTripParts extends CollectParts {
  modules(): CollectModules & {
    world: Pick<WorldGraph, 'byId' | 'shop' | 'item'> | undefined;
    travel: Pick<Travel, 'escaping' | 'combatOffForRun' | 'combatOnAfterRun'>;
  };
}

/** The trips, holding the lap while any runs. */
export function hostTrips(
  automation: AutomationConfig,
  queue: CommandQueue,
  events: StashFetchEvents & SellTripEvents & GearTripEvents,
  parts: HostTripParts
): HostTrips {
  const legs = legPlanner(parts.modules);
  const gear = new GearTrip(
    automation.enabled,
    queue,
    {
      ...legs,
      current: () => parts.modules().tracker.current,
      // Planned and walked as the character stands, never round the rooms it ran from:
      // the player asked that survival not shape this trip, only be shown on it.
      routeTo: (room) => parts.modules().errands.planFromHere(room, {}, 'walk'),
      walk: (route, run) => {
        const { walker, tracker } = parts.modules();
        const leg = { ...ERRAND_LEG, kind: 'walk' as const, offRounds: run };
        return walker.start(route, tracker.current, leg);
      },
      busy: parts.busy,
      escaping: () => parts.modules().travel.escaping,
      release: parts.release,
      combatOffForRun: () => parts.modules().travel.combatOffForRun(),
      combatOnAfterRun: () => parts.modules().travel.combatOnAfterRun(true),
      wearCommands: (bought, state) => {
        const { world } = parts.modules();
        const wanted = bought.map((buy) => ({
          name: buy.name,
          replaces: buy.replaces,
          hands: world?.item(buy.item)?.weapon?.hands ?? null
        }));
        return wearPlan(wanted, state.inventory.items);
      }
    },
    events
  );
  const sell = new SellTrip(
    automation.enabled,
    queue,
    {
      ...legs,
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
  return new HostTrips(stashFetchTrip(automation, queue, events, parts), sell, gear);
}
