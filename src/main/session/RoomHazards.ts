/**
 * A room's own spell read against this character as it stands (todo
 * 20261021-1200-01): what a way's rooms want carried against their spells
 * (`stoppersAlong`), whether the room stood in hurts (`roomHurts`, read by
 * `Recovery` and `RestAway`), which room an area search walls for its spell
 * (`stopperFor`) and where a stopper is sold (`counterFor`). The pure
 * reading is `world/navigation/stoppers.ts`; this joins it to the pack, the
 * wards stated up and the level. `mudengine-world` › `parts/routing.md`.
 */
import { tuning } from '../app/tuning';
import type { CharacterTracker } from '../parse/CharacterTracker';
import {
  hurtsUnstopped,
  stopperHeld,
  stoppersAlong,
  type RoomSpell,
  type WayStopper
} from '../world/navigation/stoppers';
import type { WorldGraph } from '../world/WorldGraph';
import { packRows, type CharacterState } from '../../shared/character';
import { roomAddress, roomId, type RoomId } from '../../shared/world';
import type { Errands } from './Errands';

/** A counter selling one of a spell's stoppers, nearest from here. */
export interface StopperCounter {
  room: RoomId;
  /** The same room as the realm addresses it, for a supply row. */
  at: { map: number; room: number };
  shop: string;
  item: { id: number; name: string };
}

export interface RoomHazardsParts {
  world:
    Pick<WorldGraph, 'byId' | 'hazardOf' | 'spellById' | 'item' | 'stockingPlaces'> | undefined;
  tracker: Pick<CharacterTracker, 'current'>;
  errands: Pick<Errands, 'travellerNow' | 'packContents' | 'spellsUp' | 'roomHazard'>;
}

export class RoomHazards {
  constructor(private readonly parts: RoomHazardsParts) {}

  /** The room spells along a way that hurt and an item stops, whatever the pack holds (`stoppersAlong`). */
  stoppersAlong(rooms: Iterable<RoomId>): WayStopper[] {
    return stoppersAlong(rooms, {
      roomSpell: (room) => this.roomSpell(room),
      itemName: (item) => this.parts.world?.item(item)?.name
    });
  }

  /**
   * The room's spell that hurts this character as it stands, named, or
   * null: the realm states a figure a tick and nothing carried or stated up
   * stops it (`hurtsUnstopped`). No rest is taken in such a room.
   */
  roomHurts(room: RoomId, state: CharacterState = this.parts.tracker.current): string | null {
    const spell = this.roomSpell(room, state);
    if (spell === null) return null;
    const { errands } = this.parts;
    const hurts = hurtsUnstopped(spell.hazard, packRows(state.inventory), errands.spellsUp(state));
    return hurts ? spell.name : null;
  }

  /** `roomHurts` for the room the character stands in; null unplaced. */
  hurtsHere(state: CharacterState): string | null {
    const here = roomAddress(state.room);
    return here === null ? null : this.roomHurts(here, state);
  }

  /**
   * The room's spell an item stops that the pack lacks, where a pass costs
   * at least `tuning.world.otherWayShare` of the bar as it stands (the
   * share the router prunes a way round at): the area search walls it.
   */
  stopperFor(room: RoomId): WayStopper | null {
    const { tracker, world, errands } = this.parts;
    const state = tracker.current;
    const found = world?.byId(room);
    const stopper = this.stoppersAlong([room])[0];
    if (found === undefined || stopper === undefined) return null;
    if (stopperHeld(stopper, packRows(state.inventory))) return null;
    const share = errands.roomHazard(
      found,
      state,
      errands.packContents(state).keys,
      errands.spellsUp(state)
    );
    return share !== null && share >= tuning().world.otherWayShare ? stopper : null;
  }

  /**
   * The nearest counter selling any of these items from where the character
   * stands, priced on the character as it stands (`stockingPlaces`), or null.
   */
  counterFor(items: readonly number[]): StopperCounter | null {
    const { tracker, world, errands } = this.parts;
    const state = tracker.current;
    const here = roomAddress(state.room);
    if (world === undefined || here === null) return null;
    const place = world.stockingPlaces(items, here, null, errands.travellerNow(state))[0];
    const item = place === undefined ? undefined : world.item(place.item);
    if (place === undefined || item === undefined) return null;
    return {
      room: roomId(place.map, place.room),
      at: { map: place.map, room: place.room },
      shop: place.shop,
      item: { id: item.id, name: item.name }
    };
  }

  /** The room's own spell as `stoppersAlong` reads it, narrowed to this character's level. */
  private roomSpell(
    room: RoomId,
    state: CharacterState = this.parts.tracker.current
  ): RoomSpell | null {
    const world = this.parts.world;
    const found = world?.byId(room);
    if (world === undefined || found === undefined || found.spell === undefined) return null;
    const hazard = world.hazardOf(found, state.progress.level);
    const spell = world.spellById(found.spell);
    return hazard === null || spell === null ? null : { id: spell.id, name: spell.name, hazard };
  }
}
