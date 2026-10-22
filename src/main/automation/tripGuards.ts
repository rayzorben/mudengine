/**
 * What every walking trip the player asked for (`AreaSearch`, `MobFinder`)
 * decides the same way: why it refuses to start, what holds it between two
 * rooms, and what ends it whatever room it is in. One reading, so a new end
 * condition reaches both; each trip says the kind in its own words.
 */
import type { CharacterState } from '../../shared/character';

export interface TripGuards {
  /** A fight here, or one auto-combat is about to open. */
  fighting(): boolean;
  /** Auto-combat fights what attacks: on, with the master switch. */
  fightsBack(): boolean;
  /** The character is running away. */
  escaping(): boolean;
  moveInFlight(): boolean;
  walking(): boolean;
  looping(): boolean;
  /** Another trip has the character. */
  busy(): boolean;
  /** The loot has a `get` waiting; omitted, never. */
  taking?(): boolean;
}

export type TripEnd = 'left-realm' | 'ran-away' | 'attacked';

export type TripRefusal = 'not-in-realm' | 'running' | 'fighting' | 'looping' | 'busy';

/** What ends the trip whatever room it is in, or null. */
export function tripEndedBy(guards: TripGuards, state: CharacterState): TripEnd | null {
  if (state.phase !== 'in-game') return 'left-realm';
  if (guards.escaping()) return 'ran-away';
  // Nothing fights back, so the next room is only further into whatever is here.
  if (guards.fighting() && !guards.fightsBack()) return 'attacked';
  return null;
}

/** What keeps the character in this room a while longer, between two rooms. */
export function tripHeld(guards: TripGuards, state: CharacterState): boolean {
  return (
    guards.fighting() ||
    state.vitals.resting ||
    state.vitals.meditating ||
    guards.moveInFlight() ||
    guards.walking() ||
    guards.taking?.() === true
  );
}

/** Why the trip cannot start now, `running` being this trip already under way; null where it can. */
export function tripRefusal(
  guards: TripGuards,
  state: CharacterState,
  running: boolean
): TripRefusal | null {
  if (state.phase !== 'in-game') return 'not-in-realm';
  if (running) return 'running';
  if (guards.fighting()) return 'fighting';
  if (guards.looping()) return 'looping';
  if (guards.moveInFlight() || guards.walking() || guards.busy()) return 'busy';
  return null;
}
