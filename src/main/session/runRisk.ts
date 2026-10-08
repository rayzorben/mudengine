/**
 * A route's risk when it is run (todos 15 and 23): each lair on it, the rounds
 * its monsters get in on a character passing with combat off (the move against
 * the round, the banked first round, the rooms a follower stays on, nothing
 * where a sneak holds past monsters that do not see hidden) and the chance
 * those rounds kill, off the odds book's fight of the lair. The router prices
 * a room by `lairRunner` and the panel's *Run it* chance is `runRiskOf`. See
 * `src/shared/runPass.ts` for the server's rules it rests on.
 */
import { SEE_HIDDEN_ABILITY, carriesAbility } from '../../shared/abilities';
import { standingOf, type CharacterState } from '../../shared/character';
import type { MovementConfig } from '../../shared/config';
import type { MobEntity } from '../../shared/entities';
import { attacksOnSight } from '../../shared/mobs';
import type { RealmFamily } from '../../shared/realm';
import {
  followRooms,
  passTicks,
  runDeath,
  runRounds,
  sneakHolds,
  standingAfter,
  type RunLair,
  type RunRisk
} from '../../shared/runPass';
import type { Odds } from '../../shared/survival';
import { parseLair, roomId, type RoomId, type Route, type WorldRoom } from '../../shared/world';
import { tuning } from '../app/tuning';

export interface RunRiskParts {
  state: CharacterState;
  movement: Pick<MovementConfig, 'sneak'>;
  family: RealmFamily | null;
  world: {
    byId(id: RoomId): WorldRoom | undefined;
    lairEntities(room: WorldRoom): MobEntity[];
  };
  lairOdds(room: WorldRoom): Odds;
  /** `tuning.hunting` at the realm's speed (`atSpeed`): the round, and the step where the family states no move delay. */
  roundSeconds: number;
  stepMs: number;
}

/** The monsters a lair holds at its cap; none where the room has no lair. */
function heldIn(room: WorldRoom | undefined): number {
  if (room?.lair === undefined) return 0;
  return parseLair(room.lair).max ?? 0;
}

/**
 * The monsters of a lair that may open on the character: all but those
 * settled not to attack on sight. Null where the lair names none it can
 * weigh, which is never the reassuring answer.
 */
export function openingOn(
  mobs: readonly MobEntity[],
  state: CharacterState
): readonly MobEntity[] | null {
  if (mobs.length === 0) return null;
  const standing = standingOf(state);
  return mobs.filter((mob) => attacksOnSight(mob.disposition, mob.abilities, standing) !== false);
}

/**
 * The likeliest follower among the monsters that may open on the character:
 * the highest `follows`, unread counted as following every move. None where
 * every monster is settled not to attack; every move where none is known.
 */
function followsOf(mobs: readonly MobEntity[], state: CharacterState): number | null {
  const opening = openingOn(mobs, state);
  if (opening === null) return null;
  let most = 0;
  for (const mob of opening) {
    if (mob.follows === undefined) return null;
    most = Math.max(most, mob.follows);
  }
  return most;
}

/** A run past one lair, stepping into `room` from `from`; null where the room has no lair. */
export type LairRunner = (room: WorldRoom, from: RoomId) => RunLair | null;

/**
 * Runs past lairs for one character as it stands: its rounds and the chance
 * they kill, a lair whose fight has not run with no death figure. Everything
 * that does not hang on the room is read once, and each room's answer is
 * kept, because the router asks for every lair it expands (todo 23 measured
 * a plan at 2.7 times as long reading them per edge).
 */
export function lairRunner(parts: RunRiskParts): LairRunner {
  const { state, world } = parts;
  const { encumbrance, encumbranceMax } = state.inventory;
  const ticks = passTicks(
    encumbrance,
    encumbranceMax,
    parts.family,
    parts.stepMs,
    parts.roundSeconds * 1000
  );
  const stealth = state.progress.stealthSkill;
  // The walker sneaks before each step where the setting asks and the sheet allows (`walk/Sneak.ts`).
  const sneaks = parts.movement.sneak && stealth !== null && stealth > 0;
  const { runFirstRounds, runFollowRooms } = tuning().world;
  // The room's own half, kept per room: only the sneak reads the room left.
  const kept = new WeakMap<
    WorldRoom,
    { rounds: number; seen: boolean; standing: (rounds: number) => number | null }
  >();
  const own = (room: WorldRoom) => {
    const known = kept.get(room);
    if (known !== undefined) return known;
    const mobs = world.lairEntities(room);
    const odds = parts.lairOdds(room);
    const read = {
      rounds: runRounds({
        ticks,
        firstRounds: runFirstRounds,
        followRooms: followRooms(followsOf(mobs, state), runFollowRooms)
      }),
      seen: mobs.some((mob) => carriesAbility(mob.abilities, SEE_HIDDEN_ABILITY)),
      /*
       * Monsters that do not open on the character kill nobody in the
       * simulated fight, so a passive lair dies of nothing here without a
       * separate rule.
       */
      standing: (rounds: number) =>
        odds.kind === 'run' ? standingAfter(odds.survival.horizons, rounds) : null
    };
    kept.set(room, read);
    return read;
  };
  return (room, from) => {
    if (room.lair === undefined) return null;
    const read = own(room);
    // The sneak is rolled on the room left (`Exits.cs:144`); players there are not counted, being unknown.
    const hidden = sneaks && !read.seen ? sneakHolds(stealth, heldIn(world.byId(from))) : 0;
    const rounds = read.rounds * (1 - hidden);
    const standing = read.standing(rounds);
    return {
      room: roomId(room.map, room.room),
      name: room.name,
      rounds,
      death: standing === null ? null : Math.max(0, 1 - standing)
    };
  };
}

export function runRiskOf(route: Route, parts: RunRiskParts): RunRisk {
  const run = lairRunner(parts);
  /*
   * Every lair, read by its own fight: a route planned without lair pricing
   * (a lap's) carries no figure on its steps, so their absence is no answer.
   */
  const lairs = route.steps.flatMap((step) => {
    if (step.lair !== true) return [];
    const room = parts.world.byId(step.to);
    const lair = room === undefined ? null : run(room, step.from);
    return lair === null ? [] : [{ ...lair, name: step.name }];
  });
  return { death: runDeath(lairs), lairs };
}
