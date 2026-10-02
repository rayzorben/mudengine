/**
 * What the trip to get rid of outgrown gear (`OutgrownGear`, todo 12) is
 * handed: the pack's outgrown items less what the player's settings keep, the
 * ganghouse the worn emblem and a carried key open, the counter that buys an
 * item, routes from here, the walker and the lap it holds. Out of
 * `SessionManager`'s constructor whole, as `trainPlanner.ts` is.
 */
import { t } from '../app/i18n';
import type { CommandQueue } from '../automation/CommandQueue';
import type { LoopRunner } from '../automation/LoopRunner';
import {
  OutgrownGear,
  type OutgrownEvents,
  type OutgrownPlanner
} from '../automation/OutgrownGear';
import type { Walker } from '../automation/Walker';
import type { CharacterTracker } from '../parse/CharacterTracker';
import { outgrownItems } from '../world/outgrownItems';
import { slotAskerOf } from '../world/slotGear';
import type { WorldGraph } from '../world/WorldGraph';
import { ownGang, type CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import { splitStop } from '../../shared/loops';
import { ganghouseHeld, keptRegardless, type KitPiece } from '../../shared/outgrown';
import { roomAddress, roomId } from '../../shared/world';
import type { Errands } from './Errands';
import { ERRAND_LEG } from './Travel';

/** The modules, read when the trip asks: several are built after it. */
export interface OutgrownPlannerModules {
  tracker: Pick<CharacterTracker, 'current' | 'pendingMoves'>;
  errands: Pick<Errands, 'planFromHere' | 'findStop' | 'travellerNow' | 'realmClass'>;
  walker: Pick<Walker, 'start' | 'walking'>;
  loops: Pick<LoopRunner, 'progress' | 'noteErrand'>;
  world:
    | Pick<
        WorldGraph,
        | 'itemsWornIn'
        | 'item'
        | 'itemIdNamed'
        | 'stockingPlaces'
        | 'classNamed'
        | 'raceId'
        | 'namedClasses'
        | 'namedRaces'
      >
    | undefined;
}

export interface OutgrownPlannerParts {
  modules(): OutgrownPlannerModules;
  config(): AutomationConfig;
  /** An escape or another trip has the character. */
  busy(): boolean;
  /** The lap given back once the trip is over. */
  release(): void;
}

/** The key ring's names as realm rows, for the ganghouse key: the pack lists keys apart. */
function keyRows(state: CharacterState, world: OutgrownPlannerModules['world']): KitPiece[] {
  return state.inventory.keys.flatMap((name): KitPiece[] => {
    const id = world?.itemIdNamed(name) ?? null;
    const row = id === null ? undefined : world?.item(id);
    if (row === undefined) return [];
    return [
      {
        name,
        equipped: false,
        ...(row.abilities === undefined ? {} : { abilities: row.abilities }),
        ...(row.kind === undefined ? {} : { kind: row.kind })
      }
    ];
  });
}

export function outgrownPlanner(parts: OutgrownPlannerParts): OutgrownPlanner {
  const m = parts.modules;
  return {
    here: () => roomAddress(m().tracker.current.room),
    outgrown: (state) => {
      const { world, errands } = m();
      if (world === undefined) return [];
      const config = parts.config();
      const kept = {
        supplies: config.supplies.items.map((row) => row.name),
        sets: config.gear.sets.flatMap((set) => set.wear),
        keys: state.inventory.keys
      };
      const asker = slotAskerOf(state, world, errands.realmClass(), config.combat.attack);
      return outgrownItems(state, world, asker).filter(
        (found) => !keptRegardless(found.item, kept)
      );
    },
    ganghouse: (state) => {
      // Unknown is not in a gang: `bg` or a `who` row says which.
      const gang = ownGang(state);
      if (gang === undefined) return { refused: t('automation.outgrown.noStashGangUnread') };
      if (gang === null) return { refused: t('automation.outgrown.noStashNoGang') };
      const held = ganghouseHeld([...state.inventory.items, ...keyRows(state, m().world)]);
      if ('missing' in held) {
        return {
          refused:
            held.missing === 'emblem'
              ? t('automation.outgrown.noStashEmblem', { gang })
              : t('automation.outgrown.noStashKey', { gang })
        };
      }
      const named = parts.config().outgrown.ganghouseRoom;
      if (named.length === 0) {
        return { refused: t('automation.outgrown.noStashRoom', { house: held.house }) };
      }
      const found = m().errands.findStop(splitStop({ room: named }));
      if (typeof found === 'string') {
        return {
          refused: t('automation.outgrown.noStashRoomUnfound', { room: named, why: found })
        };
      }
      return { room: roomId(found.map, found.room), name: named };
    },
    counterFor: (found) => {
      const { world, tracker, errands } = m();
      const here = roomAddress(tracker.current.room);
      const id = found.item.row?.id ?? found.item.id;
      if (world === undefined || here === null || id === undefined) return null;
      const traveller = errands.travellerNow(tracker.current);
      // Any counter that takes it in, a recycler's too: this is selling.
      const places = world.stockingPlaces([id], here, null, traveller, true);
      return places.reduce<(typeof places)[number] | null>(
        (best, place) => (best === null || place.moves < best.moves ? place : best),
        null
      );
    },
    routeTo: (room) => m().errands.planFromHere(room),
    walk: (route) => m().walker.start(route, m().tracker.current, ERRAND_LEG),
    moveInFlight: () => m().tracker.pendingMoves > 0,
    walking: () => m().walker.walking,
    busy: parts.busy,
    looping: () => m().loops.progress.status === 'running',
    hold: () => m().loops.noteErrand(),
    release: parts.release
  };
}

/** The trip itself, composed, so the session builds it in one call. */
export function outgrownTrip(
  automation: AutomationConfig,
  queue: CommandQueue,
  events: OutgrownEvents,
  parts: OutgrownPlannerParts
): OutgrownGear {
  return new OutgrownGear(
    automation.outgrown,
    automation.enabled,
    queue,
    outgrownPlanner(parts),
    events
  );
}
