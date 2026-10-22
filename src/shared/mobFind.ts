/**
 * Finding a monster that lairs in several rooms (the palette's *Find*): the
 * rooms are walked in the navigation engine's order and the walk stops in
 * the first one the monster stands in. Only a monster with a regen time of
 * its own (`Monsters.RegenTime`) is looked for: one that comes back with its
 * room is where the room's lair says. See `mudengine-automation` ›
 * *Finding a monster walks its lairs until it is seen*.
 */
import type { RoomId, WorldMob } from './world';

/** A monster with a clock of its own: it stays dead `regenHours` after a kill, wherever it was. */
export function hasOwnClock<M extends Pick<WorldMob, 'regenHours'>>(
  mob: M
): mob is M & { regenHours: number } {
  return mob.regenHours !== undefined && mob.regenHours > 0;
}

/** Why a monster is not one a find looks for. */
export type Unfindable = 'no-clock' | 'no-lair' | 'one-lair';

/**
 * Whether a monster is one a find looks for: with a clock of its own (one
 * that comes back with its room is where its lair says) and more than one
 * lair room (one only is *Go to*'s). `lairRooms` is every room whose lair
 * lists it. The one rule the palette's row and the plan share; a findable
 * monster comes back with its clock known.
 */
export function findable<M extends Pick<WorldMob, 'regenHours'>>(
  mob: M,
  lairRooms: number
): { ok: true; mob: M & { regenHours: number } } | { ok: false; why: Unfindable } {
  if (!hasOwnClock(mob)) return { ok: false, why: 'no-clock' };
  if (lairRooms === 0) return { ok: false, why: 'no-lair' };
  if (lairRooms === 1) return { ok: false, why: 'one-lair' };
  return { ok: true, mob };
}

/** The rooms a find walks, in order, and what it left out. */
export interface MobFindPlan {
  /** As the realm spells it. */
  mob: string;
  /** `Monsters.RegenTime`, in hours: above zero, or there is no plan. */
  regenHours: number;
  /** Every lair room reached, in the order walked. */
  rooms: RoomId[];
  /** Moves between the rooms of `rooms`, counted on the way between each pair. */
  steps: number;
  /** Lair rooms no walk from here reaches. */
  unreached: RoomId[];
}

/** The dialog's preview: the walk a find would take, or why there is none. */
export type MobFindPreview =
  | { refused: string }
  | {
      mob: string;
      /** `Monsters.RegenTime`, in hours. */
      regenHours: number;
      /** The rooms' names, in walking order. */
      rooms: string[];
      steps: number;
      unreached: string[];
      /** Auto-combat is off, so a monster met on the way ends the walk. */
      combatOff: boolean;
    };

export type MobFindEnding =
  | 'found'
  | 'not-found'
  | 'stopped'
  | 'died'
  | 'left-realm'
  | 'ran-away'
  | 'attacked'
  | 'switched-off'
  | 'missed';
