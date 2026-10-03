/**
 * How soon a room makes its monsters again, timed on the wire where the
 * world database does not say.
 *
 * `Rooms.Delay` is the realm's own clock (`respawnSeconds`), and a world
 * database exported by MegaMUD has no such column: the local GreaterMUD
 * realm's `gmud.mdb` carries `Lair` and no `Delay`, so every lair on it was
 * priced with no clock, no loop was ever sized round one, and the hunt camped
 * the cave bear between respawns with the Dungeon Entrance one step away.
 * Nor does any world database mark an arena: GreaterMUD regenerates a
 * `RoomType.Arena` room from its monster group while a player stands in it
 * (`Room.Regen`), and the Newhaven Arena is a room with no lair at all in
 * both databases the client reads.
 *
 * Both are timed the same way. The server prints a monster it regenerates as
 * an arrival (`MoveType.MobRegenning`: *A cave bear lumbers in from the
 * south!*), so standing in a room, the gap from the kill that emptied it to
 * the next monster in is one refill. Kept per realm and per room
 * (`RealmLore`), with the monsters that came, so the survey can price a room
 * the database gives nothing to, and a lair whose stated `Delay` the server
 * does not keep (`RoomClocks.lairClock`).
 *
 * Dependency-free like everything in `shared/`.
 */
import { median } from './median';
import type { CharacterState } from './character';
import { mobKey, roomAddress, type RoomId } from './world';

/** What standing in one room has taught about its refills. */
export interface LearnedSpawns {
  /** Seconds from the room emptied to the next monster in, newest last. */
  refills: number[];
  /** How often each monster, by `mobKey`, was the one that came. */
  seen: Record<string, number>;
  /** Epoch ms of the newest refill. */
  at: number;
}

/** One refill timed: the room, the gap, and who came. */
export interface RefillTimed {
  room: RoomId;
  seconds: number;
  names: string[];
}

/**
 * Folds one refill into a room's entry, keeping the newest `keep` gaps. Pure:
 * a new entry every time, so the store knows to write.
 */
export function learnRefill(
  entry: LearnedSpawns | undefined,
  refill: Pick<RefillTimed, 'seconds' | 'names'>,
  at: number,
  keep: number
): LearnedSpawns {
  const seen = { ...(entry?.seen ?? {}) };
  for (const name of refill.names) {
    const key = mobKey(name);
    if (key.length > 0) seen[key] = (seen[key] ?? 0) + 1;
  }
  return {
    refills: [...(entry?.refills ?? []), refill.seconds].slice(-Math.max(1, keep)),
    seen,
    at
  };
}

/**
 * A room's timed clock, the median gap, once it has `least` refills; null before.
 *
 * A gap under `shortest` seconds is left out: in a lair, the room read empty
 * and then full again within a second of a kill is the lair's second monster
 * coming in (the Dungeon Entrance's 0.4 to 0.9 s). An arena's sub-second
 * refills are real (the Newhaven Arena's 0.005 to 0.8 s), so its reader
 * passes no floor. On orohost such gaps were half of every lair's
 * record, and their median, 0.76 s, was the realm's usual clock: every lair
 * with no clock of its own was priced as filling the moment it emptied
 * (2026-10-03, a level-11 Mystic stood in an empty Iron Grate for four hours).
 */
export function refillClock(
  entry: LearnedSpawns | null | undefined,
  least: number,
  shortest = 0
): number | null {
  const refills = entry?.refills.filter((seconds) => seconds >= shortest) ?? [];
  if (refills.length < Math.max(1, least)) return null;
  return median(refills);
}

/**
 * The realm's usual lair clock, for a lair nobody has stood in yet: the median
 * of every timed lair's own clock. Lairs on one realm are mostly built on one
 * delay, so a lair timed once says more about the next than no clock at all.
 * Null until any room has a clock.
 */
export function usualClock(
  entries: Iterable<LearnedSpawns | null | undefined>,
  least: number,
  shortest = 0
): number | null {
  const clocks: number[] = [];
  for (const entry of entries) {
    const clock = refillClock(entry, least, shortest);
    if (clock !== null) clocks.push(clock);
  }
  return median(clocks);
}

/** What a room holds that counts toward its refill, as `RefillWatch` reads it. */
export interface RefillHeld {
  room: RoomId;
  names: string[];
  /** Something here nobody has said is a player or a monster (`RoomOccupant.kind`). */
  unsure: boolean;
}

/**
 * The monsters that count toward a room's refill: the lair's own where the
 * realm states a lair, since a wanderer walking into a lair is not the lair
 * filling; every monster where it states none. Null while the room is unplaced.
 */
export function refillCount(state: CharacterState): RefillHeld | null {
  const room = roomAddress(state.room);
  if (room === null) return null;
  const lair = new Set((state.room.lair?.mobs ?? []).map((mob) => mobKey(mob.name)));
  const ofLair = (name: string): boolean => {
    const key = mobKey(name);
    // A room prints a modifier on the row's name (`big giant rat`).
    for (const own of lair) if (key === own || key.endsWith(` ${own}`)) return true;
    return false;
  };
  const names = state.room.occupants
    .filter((who) => who.kind === 'mob')
    .map((who) => who.mob?.name ?? who.name)
    .filter((name) => lair.size === 0 || ofLair(name));
  return { room, names, unsure: state.room.occupants.some((who) => who.kind === 'unknown') };
}

/**
 * Times refills from what the room holds, line by line. A kill that emptied
 * the room while the character stood in it starts the clock; the next monster
 * in, in the same room, stops it. Only a kill: a monster walking out of a
 * corridor is not the room refilling, and timing it would make a hunting
 * ground of every street wanderers pass along. Leaving drops the clock, since
 * walking back in regenerates a room on entry (`Player.cs:782`), which is not
 * its clock; so does anything here nobody has placed, which may be a monster.
 */
export class RefillWatch {
  private room: RoomId | null = null;
  private count = 0;
  private emptiedAt: number | null = null;

  /** `killed`: the line that brought this was a death (`mob-dies`, or the experience line). */
  observe(held: RefillHeld | null, at: number, killed: boolean): RefillTimed | null {
    if (held === null || held.room !== this.room) {
      this.room = held?.room ?? null;
      this.count = held?.names.length ?? 0;
      this.emptiedAt = null;
      return null;
    }
    const before = this.count;
    this.count = held.names.length;
    if (held.unsure) {
      this.emptiedAt = null;
      return null;
    }
    if (before > 0 && this.count === 0) {
      this.emptiedAt = killed ? at : null;
      return null;
    }
    if (before === 0 && this.count > 0 && this.emptiedAt !== null) {
      const seconds = (at - this.emptiedAt) / 1000;
      this.emptiedAt = null;
      return { room: held.room, seconds, names: [...held.names] };
    }
    return null;
  }

  reset(): void {
    this.room = null;
    this.count = 0;
    this.emptiedAt = null;
  }
}

/** What a realm has taught about its rooms' refills, as a session reads and teaches it. */
export interface SpawnLore {
  /** A room's timed refills, or null where it has none. */
  spawnsAt(room: RoomId): LearnedSpawns | null;
  /** Every room with timed refills. */
  allSpawns(): ReadonlyMap<RoomId, LearnedSpawns>;
  /** One refill timed in a room. */
  observeRefill(refill: RefillTimed, at: number): void;
}

/** A realm that has timed nothing, and keeps nothing. */
export const NO_SPAWNS: SpawnLore = {
  spawnsAt: () => null,
  allSpawns: () => new Map(),
  observeRefill: () => {}
};
