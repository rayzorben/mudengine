/**
 * The trips the client walks on request: a fetch from a room (`StashFetch`)
 * and a sale at a counter (`SellTrip`), which only an extension starts, a
 * gear trip (`GearTrip`), which the player starts from the Gear card, and a
 * cash run (`CashRun`), which the player starts from the palette. The client
 * decides none of them; it walks, searches, takes, buys, sells, banks and says
 * how each ended. One module to the session, so the walk's end, the pack and a
 * death reach every one.
 */
import type { CommandQueue } from '../automation/CommandQueue';
import type { SessionModule } from '../automation/Module';
import type { AutoDeposit } from '../automation/AutoDeposit';
import type { AutoLoot } from '../automation/AutoLoot';
import { CashRun, type CashRunEvents, type CashRunPlanner } from '../automation/CashRun';
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
import { counterIn, landsFromAnywhere, roomAddress, roomId, type RoomId } from '../../shared/world';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { Travel } from './Travel';
import { ERRAND_LEG } from './Travel';

export class HostTrips implements SessionModule {
  constructor(
    readonly stash: StashFetch,
    readonly sell: SellTrip,
    readonly gear: GearTrip,
    readonly cash: CashRun
  ) {}

  get busy(): boolean {
    return this.stash.busy || this.sell.busy || this.gear.busy || this.cash.busy;
  }

  /** The player's Stop: a cash run ends with the lap it walks. */
  stop(): void {
    this.cash.stop();
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
    this.cash.onBlock(block);
  }

  onCharacter(state: CharacterState): void {
    for (const trip of this.trips) trip.onCharacter(state);
  }

  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    for (const trip of this.trips) trip.onWalkEnded(arrived, reason, state);
  }

  private get trips(): ReadonlyArray<StashFetch | SellTrip | GearTrip | CashRun> {
    return [this.stash, this.sell, this.gear, this.cash];
  }
}

/** The collect trips' modules, and the realm's counters for naming the one a sale walks to. */
export interface HostTripParts extends CollectParts {
  modules(): CollectModules & {
    world: Pick<WorldGraph, 'byId' | 'shop' | 'item' | 'banks' | 'itemIdsCarried'> | undefined;
    travel: Pick<
      Travel,
      'escaping' | 'combatOffForRun' | 'combatOnAfterRun' | 'switchedOnFor' | 'startMoving'
    >;
    loot: CollectModules['loot'] &
      Pick<AutoLoot, 'collectCoins' | 'collectCoinsAsConfigured' | 'dropCoins'>;
    deposit: Pick<AutoDeposit, 'request'>;
  };
}

/** The trips, holding the lap while any runs. */
export function hostTrips(
  automation: AutomationConfig,
  queue: CommandQueue,
  events: StashFetchEvents & SellTripEvents & GearTripEvents & CashRunEvents,
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
  const cash = new CashRun(automation.enabled, queue, cashRunPlanner(parts), events);
  return new HostTrips(stashFetchTrip(automation, queue, events, parts), sell, gear, cash);
}

/** The cash run's planner: the leg, the loop as Play starts it, the tokens carried and the banks. */
function cashRunPlanner(parts: HostTripParts): CashRunPlanner {
  const legs = legPlanner(parts.modules);
  const world = () => parts.modules().world;
  return {
    ...legs,
    current: () => parts.modules().tracker.current,
    startLoop: (name) => {
      const { travel } = parts.modules();
      return travel.switchedOnFor(() => {
        const started = travel.startMoving(name, null);
        if ('refused' in started) return started.refused;
        return 'confirm' in started ? t('automation.cashRun.refusalWandered') : null;
      });
    },
    release: parts.release,
    escaping: () => parts.modules().travel.escaping,
    tokens: (state) => {
      const graph = world();
      if (graph === undefined) return [];
      return graph.itemIdsCarried(state.inventory.items).flatMap((id) => {
        const item = graph.item(id);
        // A landing outside the dataset is a hole in the data, as for the router's portal.
        const lands =
          item !== undefined && landsFromAnywhere(item) ? graph.byId(item.lands) : undefined;
        if (item === undefined || lands === undefined) return [];
        return [{ item: id, name: item.name, lands: lands.name, fare: item.fare ?? null }];
      });
    },
    nearestBank: () => {
      const { errands, tracker } = parts.modules();
      const here = roomAddress(tracker.current.room);
      const reach = errands.tripReach();
      const graph = world();
      if (here === null || reach === null || graph === undefined) return null;
      const moves = reach.within(here, tuning().cashRun.bankSteps);
      let best: { room: RoomId; name: string; moves: number } | null = null;
      for (const bank of graph.banks()) {
        const room = roomId(bank.map, bank.room);
        const steps = moves.get(room);
        if (steps === undefined || (best !== null && best.moves <= steps)) continue;
        best = { room, name: bank.name, moves: steps };
      }
      return best === null ? null : { room: best.room, name: best.name };
    },
    collectCoins: (kinds, until) => parts.modules().loot.collectCoins(kinds, until),
    collectAsConfigured: () => parts.modules().loot.collectCoinsAsConfigured(),
    dropCoins: (counts, state) => parts.modules().loot.dropCoins(counts, state),
    // At whichever bank the run walked to, keeping back the cash on hand at the start.
    deposit: (keep, state) => parts.modules().deposit.request(keep, 'probe', state, true)
  };
}
