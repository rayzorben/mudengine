/**
 * Each installed extension's host for one character (todo 84): the session's
 * own modules, read through and acted on the way any module does, so
 * `SessionManager` composes every extension in one call.
 */
import { tuning } from '../app/tuning';
import type { AutoHunt } from '../automation/AutoHunt';
import type { Blessings } from '../automation/Blessings';
import type { CommandQueue } from '../automation/CommandQueue';
import type { ErrandStage, Supplies } from '../automation/Supplies';
import type { TrainErrand } from '../automation/TrainErrand';
import type { Walker } from '../automation/Walker';
import type { ExtensionSessionHost, ExtensionWorld, ShopTrip } from '../extensions/api';
import type { LoadedExtension } from '../extensions/ExtensionLoader';
import { SessionExtensions } from '../extensions/SessionExtensions';
import type { CharacterTracker } from '../parse/CharacterTracker';
import { gearUpgrades } from '../world/gearUpgrades';
import { wearerOf } from '../world/wearer';
import { attackOptions } from '../../shared/attackOptions';
import type { SafetyDecision } from '../../shared/automation';
import type { AutomationConfig } from '../../shared/config';
import type { LayerWrite } from '../../shared/extensions';
import type { FledEntry } from '../../shared/fled';
import type { ConnectionTarget } from '../../shared/types';
import { prowessSheetOf, wieldedWeapon } from '../../shared/verdict';
import { roomAddress, type WorldRoom } from '../../shared/world';
import type { Odds } from '../../shared/survival';
import type { Errands } from './Errands';

/** What the client's host hands a session for its extensions. */
export interface ExtensionDeps {
  extensions: readonly LoadedExtension[];
  /** The client's home. */
  home: string;
  /** The folder an extension keeps this character's records in. */
  records(name: string): string;
  /** Writes settings into this character's file; the error, or null. */
  keep(writes: readonly LayerWrite[]): string | null;
  /** The last lines of the session, colour removed. */
  backscroll(lines: number): string;
}

export interface ExtensionWiring {
  tracker: Pick<CharacterTracker, 'current'>;
  errands: Pick<
    Errands,
    'huntingGrounds' | 'realmClass' | 'capabilities' | 'travellerNow' | 'priceAt' | 'reachKey'
  >;
  world(): ExtensionWorld | undefined;
  lairOdds(room: WorldRoom): Odds;
  blessings: Pick<Blessings, 'entries'>;
  hunt: Pick<AutoHunt, 'steer' | 'hunting' | 'refusal' | 'heading' | 'waiting'>;
  supplies: Pick<Supplies, 'fetch' | 'current'>;
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
      huntingGrounds: () => errands.huntingGrounds(null),
      realmClass: () => errands.realmClass(),
      capabilities: () => errands.capabilities(),
      traveller: (state) => errands.travellerNow(state),
      priceAt: (name, shop) => errands.priceAt(name, shop),
      lairOdds: wiring.lairOdds,
      blessings: () => wiring.blessings.entries(),
      fled: wiring.fled,
      trainersAhead: (levels) => wiring.trainLevel.trainersAhead(levels, errands.reachKey()),
      gearUpgrades: (perSlot, as) => {
        const world = wiring.world();
        const state = as ?? tracker.current;
        const here = roomAddress(state.room);
        if (world === undefined || here === null) return [];
        const { combat, magery, family } = errands.realmClass();
        const traveller = errands.travellerNow(state);
        return gearUpgrades(
          state,
          {
            itemsWornIn: (worn) => world.itemsWornIn(worn),
            stockingPlaces: (items) => world.stockingPlaces(items, here, null, traveller),
            priceAt: (name, at) => errands.priceAt(name, at)
          },
          {
            wearer: wearerOf(state, world),
            sheet: prowessSheetOf(state, { combat, magery }),
            family,
            attack: wiring.config().combat.attack
          },
          perSlot
        );
      },
      attacks: () => {
        const state = tracker.current;
        const { combat, magery, family } = errands.realmClass();
        return attackOptions(
          prowessSheetOf(state, { combat, magery }),
          wieldedWeapon(state.inventory.items),
          errands.capabilities().abilities,
          family
        );
      },
      safety: wiring.safety,
      busy: wiring.busy,
      backscroll: (lines) => deps?.backscroll(lines) ?? '',
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
      walk: () => wiring.walker.progress,
      offer: (intent) => wiring.queue.offer(intent),
      layer: kit.layer,
      keep: (writes) => deps?.keep(writes) ?? null,
      notice: kit.notice,
      changed: kit.changed
    }),
    { relayer: wiring.relayer, notice: wiring.notice, changed: wiring.changed }
  );
}
