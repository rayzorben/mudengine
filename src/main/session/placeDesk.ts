/**
 * Which places take this character, and the nearest of each kind (todo 70):
 * the trainers the settings picker lists, and the palette's *Nearest* rows.
 * Moves come from the navigation engine's kept sweep for the character as it
 * stands (`Errands.reachNow`), the traveller a walk there plans with, so typing
 * `ban` then `bank` sweeps once. See `mudengine-world` › *There is one
 * navigation engine*.
 */
import { equipBlock, type EquipBlock, type Wearer } from '../../shared/gear';
import type { NearPlace, PlaceKind } from '../../shared/places';
import type { CharacterState } from '../../shared/character';
import {
  roomAddress,
  roomId,
  sells,
  type CounterPlace,
  type RoomId,
  type TrainerChoice,
  type WorldShop
} from '../../shared/world';
import type { ItemKind } from '../../shared/items';
import { wearerOf, type WearerRealm } from '../world/wearer';
import type { WorldGraph } from '../world/WorldGraph';
import type { Errands } from './Errands';

export type PlaceRealm = WearerRealm & Pick<WorldGraph, 'counters' | 'item' | 'byId'>;

export interface PlaceDeskParts {
  errands: Pick<Errands, 'trainers' | 'reachNow'>;
  tracker: { readonly current: CharacterState };
  world(): PlaceRealm | undefined;
}

export interface PlaceDesk {
  /** The trainers that will take this character, cheapest first. See `Errands.trainers`. */
  trainers(): TrainerChoice[];
  /** Every place of `kind` this character can use and reach, nearest first. */
  ofKind(kind: PlaceKind): NearPlace[];
}

export function placeDesk(parts: PlaceDeskParts): PlaceDesk {
  return {
    trainers: () => parts.errands.trainers(),
    ofKind: (kind) => {
      const world = parts.world();
      const state = parts.tracker.current;
      const here = roomAddress(state.room);
      if (world === undefined || here === null) return [];
      const candidates = placesOfKind(kind, {
        world,
        trainers: () => parts.errands.trainers(),
        wearer: wearerOf(state, world)
      });
      return nearestOf(candidates, parts.errands.reachNow(here)).flatMap(({ place, moves }) => {
        const room = world.byId(roomId(place.map, place.room));
        return room === undefined
          ? []
          : [{ kind, shop: place.shop, name: place.name, moves, room }];
      });
    }
  };
}

/** What `placesOfKind` reads, apart from the realm's counters. */
export interface KindParts {
  world: Pick<WorldGraph, 'counters' | 'item'>;
  /** Already filtered for this character's level and class. */
  trainers(): readonly TrainerChoice[];
  wearer: Wearer;
}

/** Every counter of a kind this character can use, unordered by distance. */
export function placesOfKind(kind: PlaceKind, parts: KindParts): CounterPlace[] {
  switch (kind) {
    case 'weapons':
      return parts.world.counters((shop) => sellsKit(shop, 'weapon', parts));
    case 'armour':
      return parts.world.counters((shop) => sellsKit(shop, 'armour', parts));
    case 'trainer':
      return [...parts.trainers()];
    case 'bank':
    case 'temple':
    case 'tavern':
      // Anybody may use these: the server checks a band only at `train` (`TrainCommand.cs:32`).
      return parts.world.counters((shop) => shop.kind === kind);
    default: {
      const never: never = kind;
      return never;
    }
  }
}

/**
 * Whether a counter restocks kit of this kind that this character may put on.
 * Worn kit only, so a deed shop's parchments (armour rows worn nowhere) do not
 * make it an armourer. A level not yet reached is a wait, and so is an
 * alignment, which changes in play: the gate is read as if the alignment were
 * unread, so a class or race behind it still counts. An unread class or race
 * refuses nothing (`equipBlock`).
 */
function sellsKit(shop: WorldShop, kind: ItemKind, parts: KindParts): boolean {
  const wearer: Wearer = { ...parts.wearer, alignment: null };
  return shop.items.some((line) => {
    if (!sells(line)) return false;
    const item = parts.world.item(line.id);
    if (item === undefined || item.kind !== kind || item.slot === undefined) return false;
    return !forever(equipBlock(item, wearer));
  });
}

/** A block play never lifts: the class, the race, the kind of kit the class wears, a level passed. */
function forever(block: EquipBlock | null): boolean {
  if (block === null) return false;
  switch (block.kind) {
    case 'level':
    case 'alignment':
      return false;
    case 'class':
    case 'race':
    case 'armour':
    case 'weapon':
    case 'maxLevel':
    case 'antiMagic':
      return true;
    default: {
      const never: never = block;
      return never;
    }
  }
}

/** Each place the sweep reached, fewest moves first, then by name for a stable answer. */
export function nearestOf<T extends CounterPlace>(
  places: readonly T[],
  moves: ReadonlyMap<RoomId, number>
): Array<{ place: T; moves: number }> {
  return places
    .flatMap((place) => {
      const steps = moves.get(roomId(place.map, place.room));
      return steps === undefined ? [] : [{ place, moves: steps }];
    })
    .sort((a, b) => a.moves - b.moves || a.place.name.localeCompare(b.place.name));
}
