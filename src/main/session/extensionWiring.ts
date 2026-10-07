/**
 * Each installed extension's host for one character (todo 84): the session's
 * own modules, read through and acted on the way any module does, so
 * `SessionManager` composes every extension in one call.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { AreaSearch } from '../automation/AreaSearch';
import type { AutoHunt } from '../automation/AutoHunt';
import type { Blessings } from '../automation/Blessings';
import type { CommandQueue } from '../automation/CommandQueue';
import { asSellAsk, type SellTrip } from '../automation/SellTrip';
import { asStashFetchAsk, type StashFetch } from '../automation/StashFetch';
import type { ErrandStage, Supplies } from '../automation/Supplies';
import type { TrainErrand } from '../automation/TrainErrand';
import type { Walker } from '../automation/Walker';
import type { ExtensionSessionHost, ExtensionWorld, ShopTrip } from '../extensions/api';
import type { LoadedExtension } from '../extensions/ExtensionLoader';
import { SessionExtensions } from '../extensions/SessionExtensions';
import type { CharacterTracker } from '../parse/CharacterTracker';
import { rarityBook, type RarityWorld } from '../world/itemRarity';
import { salePlaces } from '../world/salePlaces';
import { learnerOf, learning } from '../world/learning';
import { spellScrolls } from '../world/spellScrolls';
import type { SafetyDecision } from '../../shared/automation';
import type { AutomationConfig } from '../../shared/config';
import type { LayerWrite } from '../../shared/extensions';
import type { FledEntry } from '../../shared/fled';
import type { ConnectionTarget } from '../../shared/types';
import { roomAddress, unrouted } from '../../shared/world';
import type { Errands } from './Errands';
import type { GearReads } from './gearReads';
import type { OddsBook } from './OddsBook';

/** What the client's host hands a session for its extensions. */
export interface ExtensionDeps {
  extensions: readonly LoadedExtension[];
  /** The client's home. */
  home: string;
  /** The folder an extension keeps this character's records in. */
  records(name: string): string;
  /** Writes settings into this character's file; the error, or null. */
  keep(writes: readonly LayerWrite[]): string | null;
  /** The last lines of the session, escape sequences intact; older lines are read from disk. */
  backscroll(lines: number): Promise<string>;
}

export interface ExtensionWiring {
  tracker: Pick<CharacterTracker, 'current'>;
  errands: Pick<
    Errands,
    | 'huntingGrounds'
    | 'realmSpeed'
    | 'realmClass'
    | 'capabilities'
    | 'travellerNow'
    | 'routeBetween'
    | 'priceAt'
    | 'reachKey'
  >;
  world(): (ExtensionWorld & RarityWorld) | undefined;
  odds: Pick<OddsBook, 'lair' | 'lairsLeft' | 'mob' | 'mobAs'>;
  blessings: Pick<Blessings, 'entries'>;
  hunt: Pick<AutoHunt, 'steer' | 'hunting' | 'refusal' | 'heading' | 'waiting'>;
  supplies: Pick<Supplies, 'fetch' | 'current'>;
  hostTrips: {
    stash: Pick<StashFetch, 'fetch' | 'current'>;
    sell: Pick<SellTrip, 'sell' | 'current'>;
  };
  areaSearch: Pick<AreaSearch, 'last'>;
  gear: GearReads;
  trainLevel: Pick<TrainErrand, 'heading' | 'refusal' | 'trainersAhead'>;
  walker: Pick<Walker, 'progress'>;
  queue: Pick<CommandQueue, 'offer'>;
  config(): AutomationConfig;
  fled(): readonly FledEntry[];
  busy(): boolean;
  safety(): readonly SafetyDecision[];
  target(): ConnectionTarget | null;
  /** Configures the session again, so a layer lands. */
  relayer(): void;
  notice(message: string): void;
  /** The automation snapshot changed: the window is sent it. */
  changed(): void;
  deps: ExtensionDeps | undefined;
}

/** A shop trip's stage as a card says it: on the way, at the bank, at the counter. */
function tripStage(stage: ErrandStage): ShopTrip['stage'] {
  switch (stage) {
    case 'walking':
      return 'walking';
    case 'balance':
    case 'withdrawing':
      return 'bank';
    case 'waiting':
    case 'listing':
    case 'buying':
      return 'shop';
    default: {
      const never: never = stage;
      return never;
    }
  }
}

export function sessionExtensions(wiring: ExtensionWiring): SessionExtensions {
  const { tracker, errands, deps } = wiring;
  return new SessionExtensions(
    deps?.extensions ?? [],
    (extension, kit): ExtensionSessionHost => ({
      stateDir: deps?.records(extension.manifest.name) ?? null,
      home: deps?.home ?? null,
      character: () => tracker.current,
      config: wiring.config,
      tuning,
      realm: () => {
        const target = wiring.target();
        return target === null ? null : `${target.host}:${target.port}`;
      },
      world: wiring.world,
      huntingGrounds: (options) => errands.huntingGrounds(null, null, options),
      realmSpeed: () => errands.realmSpeed,
      realmClass: () => errands.realmClass(),
      capabilities: () => errands.capabilities(),
      leg: (from, to) => {
        const way = errands.routeBetween(from, to, 'walk');
        return typeof way === 'string' ? unrouted(way) : way;
      },
      priceAt: (name, shop) => errands.priceAt(name, shop),
      lairOdds: (room) => wiring.odds.lair(room),
      fightOdds: (monster, as, attack) =>
        as === undefined ? wiring.odds.mob(monster) : wiring.odds.mobAs(monster, as, attack),
      lairsUnrun: () => wiring.odds.lairsLeft,
      blessings: () => wiring.blessings.entries(),
      fled: wiring.fled,
      trainersAhead: (levels) => wiring.trainLevel.trainersAhead(levels, errands.reachKey()),
      gearUpgrades: (perSlot, as) => wiring.gear.gearUpgrades(perSlot, as),
      bestInSlot: (perSlot, as) => wiring.gear.bestInSlot(perSlot, as),
      wearing: (items, as) => wiring.gear.wearing(items, as),
      attacks: (as, against) => wiring.gear.attacks(as, against),
      spellScrolls: (as) => {
        const world = wiring.world();
        const state = as ?? tracker.current;
        const here = roomAddress(state.room);
        if (world === undefined || here === null) return [];
        const traveller = errands.travellerNow(state);
        const learner = learnerOf(state, world.classNamed(state.className ?? ''));
        return spellScrolls(state, learner, {
          itemsWhere: (test) => world.itemsWhere(test),
          spellById: (id) => world.spellById(id),
          stockingPlaces: (items) => world.stockingPlaces(items, here, null, traveller),
          priceAt: (name, at) => errands.priceAt(name, at)
        });
      },
      learning: (spells, as) => {
        const world = wiring.world();
        const state = as ?? tracker.current;
        return world === undefined ? { state, learned: [] } : learning(state, spells, world);
      },
      rarity: (item) => {
        const world = wiring.world();
        return world === undefined ? null : rarityBook(world).of(item);
      },
      areaSearched: () => wiring.areaSearch.last,
      salePlaces: (item) => {
        const world = wiring.world();
        const state = tracker.current;
        const here = roomAddress(state.room);
        if (world === undefined || here === null) return [];
        return salePlaces(item, state.progress.charm, world, here, errands.travellerNow(state));
      },
      safety: wiring.safety,
      busy: wiring.busy,
      backscroll: (lines) => deps?.backscroll(lines) ?? Promise.resolve(''),
      hunt: {
        steer: (key) => wiring.hunt.steer(key),
        get hunting() {
          return wiring.hunt.hunting;
        },
        get refusal() {
          return wiring.hunt.refusal;
        },
        get heading() {
          return wiring.hunt.heading;
        },
        get waiting() {
          return wiring.hunt.waiting;
        }
      },
      training: {
        get heading() {
          return wiring.trainLevel.heading;
        },
        get refusal() {
          return wiring.trainLevel.refusal;
        }
      },
      shopping: {
        fetch: (row) => wiring.supplies.fetch(row, tracker.current),
        get current() {
          const trip = wiring.supplies.current;
          return trip === null
            ? null
            : { item: trip.item.name, shop: trip.shopName, stage: tripStage(trip.stage) };
        }
      },
      stash: {
        record: () => tracker.current.stash,
        fetch: (ask) => {
          const parsed = asStashFetchAsk(ask);
          if (parsed !== null) return wiring.hostTrips.stash.fetch(parsed, tracker.current);
          const why = t('automation.hostTrip.refusalUnreadable');
          wiring.notice(t('automation.stashFetch.refused', { why }));
          return why;
        },
        get current() {
          return wiring.hostTrips.stash.current;
        }
      },
      selling: {
        sell: (ask) => {
          const parsed = asSellAsk(ask);
          if (parsed !== null) return wiring.hostTrips.sell.sell(parsed, tracker.current);
          const why = t('automation.hostTrip.refusalUnreadable');
          wiring.notice(t('automation.sellTrip.refused', { why }));
          return why;
        },
        get current() {
          return wiring.hostTrips.sell.current;
        }
      },
      walk: () => wiring.walker.progress,
      offer: (intent) => wiring.queue.offer(intent),
      layer: kit.layer,
      drive: kit.drive,
      keep: (writes) => deps?.keep(writes) ?? null,
      notice: kit.notice,
      changed: kit.changed
    }),
    { relayer: wiring.relayer, notice: wiring.notice, changed: wiring.changed }
  );
}
