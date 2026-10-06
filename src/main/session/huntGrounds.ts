/**
 * The three kinds of hunting ground (`HuntVia`), one row each: what the room
 * fights with, what clock the world database gives it, and what a lair does
 * that the others do not. The survey (`Errands.huntingGrounds`) reads a
 * ground through here, so a fourth kind is a row the compiler asks for.
 */
import type { WorldGraph } from '../world/WorldGraph';
import type { MobEntity } from '../../shared/entities';
import {
  refillsOnEntry,
  regenSeconds,
  respawnSeconds,
  type HuntVia,
  type HuntingConstants,
  type HuntingSpot
} from '../../shared/hunting';
import type { RealmFamily } from '../../shared/realm';
import type { RoomId, WorldRoom } from '../../shared/world';

export type GroundWorld = Pick<WorldGraph, 'lairEntities' | 'residentEntities' | 'buildMobEntity'>;

/** One ground as the row reads it: its first room, and the monsters timed coming (a `seen` room's). */
export interface Ground {
  room: WorldRoom;
  at: RoomId | null;
  came: readonly string[];
  /** A `seen` room's timed clock, in seconds. */
  timed: number | null;
}

interface GroundKind {
  /** The monsters the room fights with. */
  entities(world: GroundWorld, ground: Ground): MobEntity[];
  /** The world database's clock and where it came from, before the wire's (`RoomClocks`). */
  stated(
    ground: Ground,
    entities: readonly MobEntity[],
    family: RealmFamily | null,
    c: HuntingConstants
  ): { clock: HuntingSpot['clock']; respawn: number | null };
  /**
   * A lair: several rooms walked as a ring, priced by its fight
   * (`lairOdds`), timed by the wire past its stated `Delay`, and refilled on
   * entry where GreaterMUD's `Delay` 0 says so.
   */
  lair: boolean;
  /** Worth a detour from another spot's ring while its clock runs. */
  fills: boolean;
}

/** A placed monster's clock, `RegenTime` hours at the realm's speed. */
const regenOf = (entities: readonly MobEntity[], speed: number): number | null =>
  regenSeconds(entities[0]?.regenHours, speed);

export const GROUNDS = {
  lair: {
    entities: (world, ground) => world.lairEntities(ground.room),
    stated: (ground, _entities, family, c) => ({
      clock: ground.room.delay === undefined ? null : 'delay',
      respawn: respawnSeconds(ground.room.delay ?? null, family, c)
    }),
    lair: true,
    fills: true
  },
  resident: {
    entities: (world, ground) => world.residentEntities(ground.room),
    stated: (_ground, entities, _family, c) => {
      const respawn = regenOf(entities, c.speed);
      return { clock: respawn === null ? null : 'regenTime', respawn };
    },
    lair: false,
    // A placed boss is its own spot, never a detour.
    fills: false
  },
  seen: {
    entities: (world, ground) =>
      ground.came.map((name) => world.buildMobEntity(name, { at: ground.at })),
    stated: (ground) => ({ clock: 'timed', respawn: ground.timed }),
    lair: false,
    fills: true
  }
} satisfies Record<HuntVia, GroundKind>;

/** Whether this ground refills each time a player walks in (`refillsOnEntry`). */
export function groundRefills(via: HuntVia, room: WorldRoom, family: RealmFamily | null): boolean {
  return GROUNDS[via].lair && refillsOnEntry(room.delay, family);
}

/**
 * Whether another group's room may be taken as a filler beside a ring: a
 * ground that fills (`GROUNDS`), on a clock (a room with none is hunted on
 * luck), and not one the level ready shuts once trained for a ring that stays
 * open, whose rate would then rest on a lair it cannot keep (2026-10-06).
 */
export function admitsFiller<
  T extends { respawn: number | null; group: { via: HuntVia }; closes: boolean }
>(ring: { closes: boolean }, other: T | undefined): other is T & { respawn: number } {
  if (other === undefined || other.respawn === null || !GROUNDS[other.group.via].fills)
    return false;
  return !other.closes || ring.closes;
}
