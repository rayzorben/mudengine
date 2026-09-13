/**
 * Where to hunt: what a lair pays an hour to *this* character, from the
 * realm's own clock and the same arithmetic the Room card prices a fight
 * with. The closed-form cycle model MMUD-Explorer's Model D is built on
 * (`.scratch/MMUD-Explorer/docs/exp-per-hour-models.md`): kill the room,
 * rest what it cost, walk the loop, wait for the respawn, repeat. Every
 * constant is `tuning.hunting`; every unknown is named, never zeroed. See
 * `mudengine-world` § *Where to hunt is derived from the realm's own clock*.
 */
import type { RealmFamily } from './realm';
import type { RoomId } from './world';

/** The figures the model runs on. `tuning.hunting`, handed in whole. */
export interface HuntingConstants {
  roundSeconds: number;
  restTickSeconds: number;
  passiveTickSeconds: number;
  killOverheadMs: number;
  stepMs: number;
  greatermudRespawnOffsetSeconds: number;
  backstabMultiplier: number;
  maxLoopRooms: number;
  maxSpots: number;
  betterSpotRadius: number;
}

/** One monster a spot spawns, priced against the character. */
export interface SpotMob {
  name: string;
  /** `Monsters.EXP`, or null where the realm states none. */
  experience: number | null;
  /** Rounds to bring one down — `Verdict.rounds`, a bound. Null when unknowable. */
  rounds: number | null;
  /** Hit points a round beside it costs — `Menace.perRound`. Null when unknowable. */
  perRound: number | null;
}

/** What the character brings to the estimate. Every figure nullable. */
export interface SpotCharacter {
  hpMax: number | null;
  /** Health regained per resting tick, or null where the arithmetic is not this family's. */
  restingHealthPerTick: number | null;
  /** Health regained per standing tick; null is priced as nothing regained. */
  passiveHealthPerTick: number | null;
  /** Whether the opener is `bs`: the first blow out of the shadows is several swings. */
  backstab: boolean;
  /**
   * What a round costs in mana, for a character that fights by casting, and
   * what the pool holds — the caster's half of the cycle (todo 26,
   * 2026-09-12; todo 05 left it out and named todo 09 as the prerequisite,
   * which has since landed).
   *
   * **Symmetric with the rest half.** A melee character's cycle is bounded by
   * the health it loses and the time to get it back; a caster's is bounded by
   * the mana it spends and the time to meditate it back. Priced the same way:
   * what standing regains is taken off first, and only the remainder is paid
   * for at the sitting rate.
   *
   * All four null for a character that does not cast, which is every
   * character until `automation.spells` names a round spell — and null here
   * costs **nothing**, never a guess, so a Warrior's estimate is exactly what
   * it was.
   */
  manaPerRound: number | null;
  manaMax: number | null;
  /** Mana regained per meditating tick; null where the arithmetic is not known. */
  meditatingManaPerTick: number | null;
  /** Mana regained per standing tick; null is priced as nothing regained. */
  passiveManaPerTick: number | null;
}

export interface SpotInput {
  /** Rooms the loop visits — the cluster sharing this lair, at most `maxLoopRooms`. */
  rooms: number;
  /** `(Max N)` — how many are up at once per room. Null reads as one. */
  spawns: number | null;
  mobs: SpotMob[];
  /** Effective seconds until a room makes monsters again; null when unstated. */
  respawnSeconds: number | null;
  /** Steps around the cluster and back; 0 for a single room. */
  loopSteps: number;
  character: SpotCharacter;
}

export type HuntingUnknown =
  | 'experience'
  | 'rounds'
  | 'damage'
  | 'respawn'
  | 'rest'
  | 'health'
  /** The pool a caster's cycle is bounded by, and the rate it comes back at. */
  | 'mana';

export interface SpotEstimate {
  /** The answer, or null while a part it needs is unknown. */
  expPerHour: number | null;
  /** The spawn-rate bound: what the lair pays if every kill were free. */
  ceilingPerHour: number | null;
  expPerCycle: number | null;
  cycleSeconds: number | null;
  combatSeconds: number | null;
  restSeconds: number | null;
  walkSeconds: number;
  /** Time spent standing for the respawn, once the cycle is faster than the clock. */
  waitSeconds: number | null;
  /** Health one room's cycle takes off the character. */
  damagePerRoom: number | null;
  /**
   * Seconds the cycle spends meditating the mana back, or null while the pool
   * or its rate is unknown. **0 for a character that does not cast**, which is
   * the ordinary case and costs the estimate nothing.
   */
  meditateSeconds: number | null;
  /** `damagePerRoom / hpMax`. */
  damageShare: number | null;
  /** Mean rounds per kill, the opener credited. */
  roundsPerKill: number | null;
  /** One room's cycle is expected to take the whole bar. */
  deadly: boolean;
  unknown: HuntingUnknown[];
}

/**
 * `Rooms.Delay`, read as `Room.GetDelayInSeconds` reads it and then as the
 * family's regen actually compares it.
 *
 * Minutes; an Arena room's figure is seconds (the client cannot see the room
 * type, so `arena` is the caller's word) and a negative figure is seconds
 * outright. GreaterMUD then adds thirty seconds to the elapsed time before
 * comparing (`RegenSlot.cs:33`), so its lairs come back that much sooner —
 * measured 18–20s in a `Delay=1` lair against a nominal 60. Never below zero,
 * and null for a room that states no clock.
 */
export function respawnSeconds(
  delay: number | null | undefined,
  family: RealmFamily | null,
  constants: Pick<HuntingConstants, 'greatermudRespawnOffsetSeconds'>,
  arena = false
): number | null {
  if (delay === null || delay === undefined || !Number.isFinite(delay) || delay === 0) return null;
  const nominal = delay > 0 ? delay * (arena ? 1 : 60) : Math.abs(delay);
  if (family !== 'greatermud') return nominal;
  return Math.max(0, nominal - constants.greatermudRespawnOffsetSeconds);
}

/** The mean of the stated figures, or null when none is stated. */
function mean(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (known.length === 0) return null;
  return known.reduce((sum, value) => sum + value, 0) / known.length;
}

/**
 * One spot, estimated.
 *
 * The cycle: kill the room's `spawns` in turn (the pack ramps down — while the
 * k-th dies the rest are still swinging), pay the kill overhead, walk the
 * loop, rest what the cycle cost past what standing regained, and if that was
 * quicker than the respawn, wait for it. A backstabber's opener is credited
 * as `backstabMultiplier` rounds of damage on the first blow: every kill in a
 * room of singles (the shadows are regained between them), the first of a
 * pack otherwise. Nothing here is a prediction; it is the realm's figures and
 * the character's own, folded once, with every unknown named.
 */
export function estimateSpot(input: SpotInput, c: HuntingConstants): SpotEstimate {
  const unknown: HuntingUnknown[] = [];
  const spawns = Math.max(1, input.spawns ?? 1);
  const rooms = Math.max(1, input.rooms);
  const walkSeconds = (Math.max(0, input.loopSteps) * c.stepMs) / 1000;

  const experience = mean(input.mobs.map((mob) => mob.experience));
  const rounds = mean(input.mobs.map((mob) => mob.rounds));
  const perRound = mean(input.mobs.map((mob) => mob.perRound));
  if (experience === null) unknown.push('experience');
  if (rounds === null) unknown.push('rounds');
  if (perRound === null) unknown.push('damage');
  if (input.respawnSeconds === null) unknown.push('respawn');
  if (input.character.hpMax === null) unknown.push('health');

  // Rounds per kill, the opener credited where it can land.
  let roundsPerKill: number | null = null;
  let roundsPerRoom: number | null = null;
  let damagePerRoom: number | null = null;
  if (rounds !== null) {
    const plain = Math.max(0.5, rounds);
    const opened = Math.max(0.5, 1 + Math.max(0, rounds - c.backstabMultiplier));
    const perKill: number[] = [];
    for (let k = 0; k < spawns; k += 1) {
      const first = k === 0 || spawns === 1;
      perKill.push(input.character.backstab && first ? opened : plain);
    }
    roundsPerRoom = perKill.reduce((sum, value) => sum + value, 0);
    roundsPerKill = roundsPerRoom / spawns;
    if (perRound !== null) {
      // While the k-th dies, the ones after it are still swinging.
      damagePerRoom = perKill.reduce(
        (sum, value, index) => sum + perRound * value * (spawns - index),
        0
      );
    }
  }

  const combatSeconds =
    roundsPerRoom === null
      ? null
      : rooms * (roundsPerRoom * c.roundSeconds + (spawns * c.killOverheadMs) / 1000);

  const damagePerCycle = damagePerRoom === null ? null : damagePerRoom * rooms;
  let restSeconds: number | null = null;
  if (damagePerCycle !== null && combatSeconds !== null) {
    const standing = combatSeconds + walkSeconds;
    const passive =
      input.character.passiveHealthPerTick === null
        ? 0
        : (standing / c.passiveTickSeconds) * input.character.passiveHealthPerTick;
    const need = Math.max(0, damagePerCycle - passive);
    if (need === 0) restSeconds = 0;
    else if (input.character.restingHealthPerTick === null) unknown.push('rest');
    else if (input.character.restingHealthPerTick <= 0) unknown.push('rest');
    else {
      restSeconds = Math.ceil(need / input.character.restingHealthPerTick) * c.restTickSeconds;
    }
  }

  /*
   * And the caster's half, the same shape as the rest above (todo 26).
   *
   * A melee cycle is bounded by the health it loses and the time to get it
   * back; a caster's is bounded by the mana it spends and the time to
   * meditate it back — which is the reviewer's *cluster and room-spell, then
   * sit* play, priced rather than written in. What standing regains is taken
   * off first, exactly as for health.
   *
   * **Zero for a character that does not cast**, which is every one until a
   * round spell is configured: a null cost is not an unknown, it is nothing
   * spent, and a Warrior's estimate is unchanged to the second.
   */
  let meditateSeconds: number | null = 0;
  const manaPerRound = input.character.manaPerRound;
  if (manaPerRound !== null && manaPerRound > 0 && roundsPerRoom !== null) {
    const manaPerCycle = manaPerRound * roundsPerRoom * rooms;
    const standing = (combatSeconds ?? 0) + walkSeconds;
    const passive =
      input.character.passiveManaPerTick === null
        ? 0
        : (standing / c.passiveTickSeconds) * input.character.passiveManaPerTick;
    const need = Math.max(0, manaPerCycle - passive);
    if (need === 0) meditateSeconds = 0;
    else if (
      input.character.meditatingManaPerTick === null ||
      input.character.meditatingManaPerTick <= 0
    ) {
      meditateSeconds = null;
      unknown.push('mana');
    } else {
      meditateSeconds = Math.ceil(need / input.character.meditatingManaPerTick) * c.restTickSeconds;
    }
  }

  const expPerCycle = experience === null ? null : experience * spawns * rooms;
  const ceilingPerHour =
    expPerCycle === null || input.respawnSeconds === null
      ? null
      : input.respawnSeconds <= 0
        ? null
        : (expPerCycle * 3600) / input.respawnSeconds;

  const hpMax = input.character.hpMax;
  const damageShare =
    damagePerRoom === null || hpMax === null || hpMax <= 0 ? null : damagePerRoom / hpMax;
  const deadly = damageShare !== null && damageShare >= 1;

  let cycleSeconds: number | null = null;
  let waitSeconds: number | null = null;
  let expPerHour: number | null = null;
  if (
    combatSeconds !== null &&
    restSeconds !== null &&
    meditateSeconds !== null &&
    input.respawnSeconds !== null &&
    expPerCycle !== null &&
    !deadly
  ) {
    // Resting and meditating are both sitting still, so they add rather than
    // overlapping: the server's own two commands exclude each other.
    const active = combatSeconds + walkSeconds + restSeconds + (meditateSeconds ?? 0);
    cycleSeconds = Math.max(active, input.respawnSeconds);
    waitSeconds = cycleSeconds - active;
    expPerHour = cycleSeconds > 0 ? (expPerCycle * 3600) / cycleSeconds : null;
  }

  return {
    expPerHour,
    ceilingPerHour,
    expPerCycle,
    cycleSeconds,
    combatSeconds,
    restSeconds,
    meditateSeconds,
    walkSeconds,
    waitSeconds,
    damagePerRoom,
    damageShare,
    roundsPerKill,
    deadly,
    unknown
  };
}

/** One room a suggested loop visits. */
export interface HuntingRoom {
  id: RoomId;
  map: number;
  room: number;
  name: string;
  /** Fewest steps from where the character stands. */
  steps: number;
}

/** One suggestion: a lair, the rooms that hold it, and what it is worth. */
export interface HuntingSpot {
  /** The lair's signature, stable across asks. */
  key: string;
  /** The monsters, as the realm names them. */
  mobs: SpotMob[];
  /** Where the clock came from: the room's `Delay`, or a placed monster's `RegenTime`. */
  clock: 'delay' | 'regenTime' | null;
  respawnSeconds: number | null;
  spawns: number | null;
  /** The rooms a loop would visit, nearest first, at most `maxLoopRooms`. */
  rooms: HuntingRoom[];
  /** How many rooms in the neighbourhood hold this lair, the loop's or not. */
  roomCount: number;
  loopSteps: number;
  estimate: SpotEstimate;
}

/** What the model assumed, so the reader can weigh the answer. */
export interface HuntingAssumptions {
  family: RealmFamily | null;
  hpMax: number | null;
  restingHealthPerTick: number | null;
  backstab: boolean;
  constants: HuntingConstants;
}

export interface HuntingAdvice {
  /** Where the sweep started, or null when the character is unplaced. */
  from: { id: RoomId; name: string } | null;
  /** How far it looked, in steps. */
  radius: number;
  spots: HuntingSpot[];
  assumptions: HuntingAssumptions;
  /** Why there is no answer, said out loud. */
  refusal: string | null;
}

/**
 * The order the reader wants: a known rate first, highest first; then a
 * spot whose rate could not be finished, by its ceiling; a deadly spot last,
 * whatever it pays. An unknown rate is never a high one.
 */
export function compareSpots(a: HuntingSpot, b: HuntingSpot): number {
  const rank = (spot: HuntingSpot): number =>
    spot.estimate.deadly ? 2 : spot.estimate.expPerHour === null ? 1 : 0;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  const va = ra === 0 ? a.estimate.expPerHour! : (a.estimate.ceilingPerHour ?? -1);
  const vb = rb === 0 ? b.estimate.expPerHour! : (b.estimate.ceilingPerHour ?? -1);
  if (va !== vb) return vb - va;
  return a.rooms[0]!.steps - b.rooms[0]!.steps;
}
