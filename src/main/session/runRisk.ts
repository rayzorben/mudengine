/**
 * A route's risk when it is run (todos 15 and 23): each lair on it, the rounds
 * its monsters get in on a character passing with combat off (the move against
 * the round, the banked first round, the rooms a follower stays on, nothing
 * where a sneak holds past monsters that do not see hidden) and the chance
 * those rounds kill, off the odds book's fight of the lair; and a room with no
 * lair by the monsters that may wander in with the character (`wanderersOf`,
 * todo 25), each by its own fight. The router prices a room by `lairRunner` and the panel's
 * *Run it* chance is `runRiskOf`. See `src/shared/runPass.ts` for the
 * server's rules it rests on.
 */
import { SEE_HIDDEN_ABILITY, carriesAbility } from '../../shared/abilities';
import { standingOf, type CharacterState } from '../../shared/character';
import type { MovementConfig } from '../../shared/config';
import type { MobEntity } from '../../shared/entities';
import { waitsToBeStruck } from '../../shared/mobs';
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
import { wanderersOf, type WandererWorld } from './wanderersIn';

export interface RunRiskParts {
  state: CharacterState;
  movement: Pick<MovementConfig, 'sneak'>;
  family: RealmFamily | null;
  world: WandererWorld & {
    byId(id: RoomId): WorldRoom | undefined;
    lairEntities(room: WorldRoom): MobEntity[];
  };
  lairOdds(room: WorldRoom): Odds;
  /** One monster fought alone, arrivals and all: a wanderer's fight. */
  mobOdds(name: string): Odds;
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
 * The monsters of a lair or a wanderer that may open on the character: all
 * but those settled not to attack on sight. Null where it names none it can
 * weigh, which is never the reassuring answer.
 */
export function openingOn(
  mobs: readonly MobEntity[],
  state: CharacterState
): readonly MobEntity[] | null {
  if (mobs.length === 0) return null;
  const standing = standingOf(state);
  return mobs.filter((mob) => !waitsToBeStruck(mob, standing));
}

/** Whether one monster may open on the character (`openingOn`). */
export function opensOn(mob: MobEntity, state: CharacterState): boolean {
  return openingOn([mob], state)?.length === 1;
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

/**
 * A run past one lair, or a room's wanderers, stepping into `room` from
 * `from`; null where the room has neither.
 */
export type LairRunner = (room: WorldRoom, from: RoomId) => RunLair | null;

/**
 * What may get at a runner in one room: the lair whole, or one of the room's
 * wanderers, how likely it is there, its rounds and the fight they are read off.
 */
interface Exposure {
  chance: number;
  rounds: number;
  seen: boolean;
  standing: (rounds: number) => number | null;
}

/**
 * Runs past lairs and wanderers for one character as it stands: their rounds
 * and the chance they kill, a fight that has not run with no death figure.
 * Everything that does not hang on the room is read once, and each room's
 * answer is kept, because the router asks for every room it expands (todo 23
 * measured a plan at 2.7 times as long reading them per edge).
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
  const exposed = (
    mobs: readonly MobEntity[],
    chance: number,
    odds: Odds,
    follows: number | null
  ): Exposure => ({
    chance,
    rounds: runRounds({
      ticks,
      firstRounds: runFirstRounds,
      followRooms: followRooms(follows, runFollowRooms)
    }),
    seen: mobs.some((mob) => carriesAbility(mob.abilities, SEE_HIDDEN_ABILITY)),
    /*
     * Monsters that do not open on the character kill nobody in the
     * simulated fight, so a passive lair dies of nothing here without a
     * separate rule.
     */
    standing: (rounds: number) =>
      odds.kind === 'run' ? standingAfter(odds.survival.horizons, rounds) : null
  });
  /*
   * The room's own half, kept per room: only the sneak reads the room left.
   * Null where nothing is in the room; empty where what is waits to be struck.
   */
  const kept = new WeakMap<WorldRoom, readonly Exposure[] | null>();
  const own = (room: WorldRoom): readonly Exposure[] | null => {
    const known = kept.get(room);
    if (known !== undefined) return known;
    let read: Exposure[] | null;
    if (room.lair !== undefined) {
      const mobs = world.lairEntities(room);
      read = [exposed(mobs, 1, parts.lairOdds(room), followsOf(mobs, state))];
    } else {
      const met = wanderersOf(room, world);
      // A wanderer that waits to be struck gets no round in on a runner.
      read =
        met.length === 0
          ? null
          : met.flatMap(({ entity, chance }) =>
              opensOn(entity, state)
                ? [
                    exposed(
                      [entity],
                      chance,
                      parts.mobOdds(entity.name),
                      followsOf([entity], state)
                    )
                  ]
                : []
            );
    }
    kept.set(room, read);
    return read;
  };
  return (room, from) => {
    const read = own(room);
    if (read === null) return null;
    // The sneak is rolled on the room left (`Exits.cs:144`); players there are not counted, being unknown.
    const others = sneaks ? heldIn(world.byId(from)) : 0;
    let rounds = 0;
    let death: number | null = 0;
    for (const each of read) {
      const hidden = sneaks && !each.seen ? sneakHolds(stealth, others) : 0;
      const got = each.rounds * (1 - hidden);
      rounds += each.chance * got;
      if (got <= 0) continue;
      const standing = each.standing(got);
      // Each is the one met on this pass, so the deaths add at their chances.
      death = standing === null || death === null ? null : death + each.chance * (1 - standing);
    }
    return {
      room: roomId(room.map, room.room),
      name: room.name,
      rounds,
      death: death === null ? null : Math.max(0, death)
    };
  };
}

export function runRiskOf(route: Route, parts: RunRiskParts): RunRisk {
  const run = lairRunner(parts);
  /*
   * Every lair and room of wanderers, read by its own fight: a route planned without
   * lair pricing (a lap's) carries no figure on its steps, so their absence
   * is no answer.
   */
  const lairs = route.steps.flatMap((step) => {
    const room = parts.world.byId(step.to);
    const lair = room === undefined ? null : run(room, step.from);
    return lair === null ? [] : [{ ...lair, name: step.name }];
  });
  return { death: runDeath(lairs), lairs };
}
