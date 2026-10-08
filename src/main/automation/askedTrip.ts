/**
 * What every trip an extension starts through the host shares (`StashFetch`,
 * `SellTrip`): its ask parsed at the boundary, since an extension is
 * JavaScript the client did not build, and whether the character is free to
 * set off now. Each trip keeps only its own extra refusals.
 */
import { t } from '../app/i18n';
import type { CharacterState } from '../../shared/character';
import { asRoomReference, roomId, type RoomId } from '../../shared/world';

/** A room and the items named for it, as the pack names them. */
export interface RoomAndItems {
  room: RoomId;
  items: readonly string[];
}

/**
 * The room and the names out of an extension's ask: a room that is not
 * `map/room`, or a list with anything but names in it, is no ask at all. A
 * name is trimmed, and a name twice is one: the first `get` or `sell` takes
 * the stack.
 */
export function asRoomAndItems(value: unknown): RoomAndItems | null {
  if (typeof value !== 'object' || value === null) return null;
  const { room, items } = value as Record<string, unknown>;
  const place = typeof room === 'string' ? asRoomReference(room) : null;
  if (place === null || !Array.isArray(items)) return null;
  const named = items.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0
  );
  if (named.length !== items.length) return null;
  return {
    room: roomId(place.map, place.room),
    items: [...new Set(named.map((item) => item.trim()))]
  };
}

/** What the session tells a trip about the character, and the lap the trip holds while it runs. */
export interface TripPlanner {
  moveInFlight(): boolean;
  walking(): boolean;
  /** An escape or another trip has the character. */
  busy(): boolean;
  looping(): boolean;
  /** Holds the lap for the trip, and gives it back. */
  hold(): void;
  release(): void;
}

/**
 * Why the character may not set off now on a trip for `items`: the trip
 * switched off or already under way, nothing named, or the character not
 * free. A resting character sets off: the first step ends the rest, and the
 * walk holds to rest where `restBelow` says to (`Holds.holdForHealth`). Null
 * where it may.
 */
export function tripRefusal(
  items: readonly string[],
  trip: { enabled: boolean; running: boolean },
  state: CharacterState,
  planner: Pick<TripPlanner, 'moveInFlight' | 'walking' | 'busy'>
): string | null {
  if (!trip.enabled) return t('automation.hostTrip.refusalSwitchedOff');
  if (state.phase !== 'in-game') return t('automation.hostTrip.refusalNotInRealm');
  if (trip.running) return t('automation.hostTrip.refusalBusy');
  if (items.length === 0) return t('automation.hostTrip.refusalNothingNamed');
  if (state.inCombat || state.combat.attackers.length > 0) {
    return t('automation.hostTrip.refusalFighting');
  }
  if (planner.moveInFlight() || planner.walking() || planner.busy()) {
    return t('automation.hostTrip.refusalBusy');
  }
  return null;
}
