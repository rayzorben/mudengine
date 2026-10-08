/**
 * Where to hunt: what a lair pays an hour to *this* character, from the
 * realm's own clock and the same arithmetic the Room card prices a fight
 * with. The closed-form cycle model MMUD-Explorer's Model D is built on
 * (`.scratch/MMUD-Explorer/docs/exp-per-hour-models.md`): kill the room,
 * recover what it cost, walk the loop, wait for the respawn, repeat — the
 * loop sized to the clock and filled from the lairs beside it. Every
 * constant is `tuning.hunting`; every unknown is named, never zeroed. See
 * `mudengine-world` § *Where to hunt is derived from the realm's own clock*.
 */
import { median } from './median';
import type { MeasuredOutput } from './fights';
import type { UiLookup } from './i18n';
import type { Loop, LoopStop } from './loops';
import type { MobAffliction } from './menace';
import type { CharacterState } from './character';
import type { RealmFamily } from './realm';
import type { RoomId } from './world';

/**
 * The model's figures (`atSpeed` builds them). Every server clock among them
 * is the realm's own, the server's divided by `speed`; a figure the world
 * database states in the server's units (a lair's `Delay`, a monster's
 * `RegenTime`) is divided where it is read.
 */
export interface HuntingConstants {
  /** How many times faster than the server's own clocks the realm runs (`RealmSpeed`). */
  speed: number;
  roundSeconds: number;
  restTickSeconds: number;
  passiveTickSeconds: number;
  /** The pass that refills a room a player stands in (`RegenTickTime`). */
  roomRegenSeconds: number;
  killOverheadMs: number;
  /** One step where the pack's weight is unknown — the measured movement round. */
  stepMs: number;
  greatermudRespawnOffsetSeconds: number;
  backstabMultiplier: number;
  maxLoopRooms: number;
  maxSpots: number;
  betterSpotRadius: number;
  /** A room whose one cycle takes more than this share of the bar is too dangerous to start in. */
  maxDamageShare: number;
  /** A room that could not take this share off an *unarmoured* character is beneath this level. */
  trivialShare: number;
  /** The bar is read this much lower for that test — the level less five percent. */
  trivialLevelMargin: number;
  /** How far apart a loop's own rooms are measured, in steps. */
  clusterRadius: number;
  /** How far off the ring a filler lair may lie, in steps. */
  fillerRadius: number;
  /**
   * How far under the best rate a smaller loop may fall and still be chosen:
   * past the clock the rate is flat but for the rounding of rest ticks, and
   * the fewest rooms that reach it is the loop worth walking.
   */
  sizeTolerance: number;
}

/** The server clocks `atSpeed` divides; the rest are the client's own or no clock at all. */
type ServerClock =
  | 'roundSeconds'
  | 'restTickSeconds'
  | 'passiveTickSeconds'
  | 'roomRegenSeconds'
  | 'stepMs'
  | 'greatermudRespawnOffsetSeconds';

/**
 * The model's figures at a realm's speed (`RealmSpeed`, GreaterMUD's
 * `GameSpeedMultiplier`): every server clock divided by it, the rest as given.
 * The one place the tuning clocks are scaled, so no reader mixes the two.
 */
export function atSpeed<T extends Omit<HuntingConstants, 'speed'>>(
  server: T,
  speed: number
): T & HuntingConstants {
  const clocks = {} as Pick<HuntingConstants, ServerClock>;
  for (const key of [
    'roundSeconds',
    'restTickSeconds',
    'passiveTickSeconds',
    'roomRegenSeconds',
    'stepMs',
    'greatermudRespawnOffsetSeconds'
  ] as const satisfies readonly ServerClock[]) {
    clocks[key] = server[key] / speed;
  }
  return { ...server, ...clocks, speed };
}

/**
 * Where the realm's speed is kept between connections, by the address dialled
 * (`WorldBook`), so a connection's first survey and first fight run at it.
 */
export interface KeptSpeed {
  recall(): number | null;
  remember(speed: number): void;
}

/** Nowhere: a test, or a session with no home to write to. */
export const NOT_KEPT: KeptSpeed = { recall: () => null, remember: () => {} };

/** A monster's own clock, `Monsters.RegenTime` hours, in seconds at the realm's speed; null where it states none. */
export function regenSeconds(hours: number | undefined, speed: number): number | null {
  return hours === undefined ? null : (hours * 3600) / speed;
}

/**
 * What sitting gives back a second: the rest tick's figure every
 * `restTickSeconds` (`CalcRestTick`: resting `HPRegen × 3`, meditating
 * `GetBaseMARegen`) and the standing tick's every `passiveTickSeconds`
 * (`DoHPTick`, which runs whatever the character is doing).
 */
export function sittingPerSecond(
  perRestTick: number,
  perStandingTick: number,
  c: Pick<HuntingConstants, 'restTickSeconds' | 'passiveTickSeconds'>
): number {
  return perRestTick / c.restTickSeconds + perStandingTick / c.passiveTickSeconds;
}

/** One monster a spot spawns, priced against the character. */
export interface SpotMob {
  name: string;
  /** `Monsters.EXP`, or null where the realm states none. */
  experience: number | null;
  /**
   * The copper a kill is expected to carry (`expectedCopper`), or null on a
   * realm file built before monsters' coins were read (format 49).
   */
  copper: number | null;
  /** Rounds to bring one down — `Verdict.rounds`, a bound. Null when unknowable. */
  rounds: number | null;
  /** Hit points a round beside it costs — `Menace.perRound`. Null when unknowable. */
  perRound: number | null;
  /** The same round against an unarmoured character, for the *beneath this level* test. */
  nakedPerRound: number | null;
  /** What it can put on the character besides wounds, with the realm's duration. */
  afflictions: MobAffliction[];
  /**
   * `Monsters.RegenTime` in seconds, where the realm states one for this row
   * (todo 09, 2026-09-13).
   *
   * A lair's room comes back on its own `Rooms.Delay`, but a row the realm
   * gives a clock of its own does not: the Gravedigger is a 1,500-point
   * monster on a **one-hour** regeneration, and a lair holding it was priced
   * as though it spawned every minute with the rest. So a row's experience is
   * weighted by the share of cycles it is actually up. Null is the ordinary
   * case, and means *on the room's clock*.
   */
  regenSeconds: number | null;
}

/** The configured heal, priced from its realm row: what one cast mends and spends. */
export interface HealingCast {
  hpPerCast: number;
  manaPerCast: number;
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
   * what the pool holds — the caster's half of the cycle (todo 26). Priced
   * like the rest half: what standing regains is taken off first, the
   * remainder paid at the sitting rate. Null costs **nothing**, never a guess.
   */
  manaPerRound: number | null;
  manaMax: number | null;
  /** Mana regained per meditating tick; null where the arithmetic is not known. */
  meditatingManaPerTick: number | null;
  /** Mana regained per standing tick; null is priced as nothing regained. */
  passiveManaPerTick: number | null;
  /** One step, from the pack's weight (`moveDelayMs`); null prices the measured `stepMs`. */
  stepMs: number | null;
  /**
   * The heal the character casts, or null. A cast that mends is a rest that
   * costs a round and mana instead of sitting time, and — because `rest` is
   * refused to a poisoned character where casting is not — the way past a
   * poisoned wait. The cycle takes whichever recovery is quicker.
   */
  heal: HealingCast | null;
  /**
   * True where the server refuses `rest` while poisoned and nothing this
   * character has lifts it: not immune by race, no cure spell, no antidote
   * rule. Then a lair that poisons stands the character for the poison's
   * stated length before a rest can begin.
   */
  poisonHoldsRest: boolean;
}

/** A lair beside the ring, visited while the primary's clock runs. */
export interface FillerInput {
  spawns: number | null;
  mobs: SpotMob[];
  /** Its own clock, which must be known: a room with none is hunted on luck. */
  respawnSeconds: number;
  /** Steps off the ring and back. */
  detourSteps: number;
  /** Refilled on entry, so nothing to wait for on a lap (`refillsOnEntry`). */
  refillsOnEntry?: boolean;
}

export interface SpotInput {
  /** Rooms of the lair the loop visits, at most `maxLoopRooms`. */
  rooms: number;
  /** `(Max N)` — how many are up at once per room. Null reads as one. */
  spawns: number | null;
  mobs: SpotMob[];
  /** Effective seconds until a room makes monsters again; null when unstated. */
  respawnSeconds: number | null;
  /** Steps round the ring and back to its first room; 0 for a single room. */
  loopSteps: number;
  character: SpotCharacter;
  filler: FillerInput[];
  /**
   * The lair is refilled whenever a player walks in (GreaterMUD, `Delay` 0):
   * a loop of two stops or more re-enters it every lap, so there is no wait.
   */
  refillsOnEntry?: boolean;
  /**
   * The odds book ran this lair's fight at its cap and it came out safe
   * (2026-10-04): the run fight, which rolls every blow, dodge and heal,
   * answers *deadly* and *costly* instead of the floor, which charges the
   * worst spawn's blows at its full rounds and cut every lair a level 1 Mage
   * casting magic missile could hunt (worst 60% of the bar, every fight won).
   */
  fightRun?: boolean;
  /**
   * The share of the odds book's fights here won (todo 16): a fight run from
   * pays nothing, so the lair's exp and copper are priced at this share.
   * Absent where the fight has not run, priced as every fight won.
   */
  wins?: number;
}

export type HuntingUnknown =
  | 'experience'
  | 'rounds'
  | 'damage'
  | 'respawn'
  | 'rest'
  | 'health'
  /** The pool a caster's cycle is bounded by, and the rate it comes back at. */
  | 'mana'
  /** How long a poison that refuses the rest lasts. */
  | 'poison';

export interface SpotEstimate {
  /** The answer, or null while a part it needs is unknown. */
  expPerHour: number | null;
  /**
   * The model's own figure before a measured pace or a carried ratio scaled
   * it (`withMeasured`): what a measured rate is kept beside. Absent before
   * `withMeasured` has run.
   */
  modelPerHour?: number | null;
  /**
   * What hunting it actually paid this character at this level, where a hunt
   * there lasted long enough to say, and when (todo 70). A measured rate
   * outranks `expPerHour` wherever a spot is ranked (`spotRate`).
   */
  measured?: { perHour: number; minutes: number; at: number } | null;
  /** The spawn-rate bound: what the lair pays if every kill were free. */
  ceilingPerHour: number | null;
  expPerCycle: number | null;
  /** What the filler rooms add to a cycle's experience, at the share of visits that find them up. */
  fillerExpPerCycle: number;
  /**
   * The copper a cycle's kills are expected to carry, weighed exactly as the
   * exp is, and an hour of it. Null where a monster's coins are unknown, and
   * the hour also while the cycle is. Nothing is ranked by it.
   */
  copperPerCycle: number | null;
  copperPerHour: number | null;
  cycleSeconds: number | null;
  combatSeconds: number | null;
  restSeconds: number | null;
  walkSeconds: number;
  /** One step as priced, in milliseconds. */
  stepMs: number;
  /** Time spent standing for the respawn, once the cycle is faster than the clock. */
  waitSeconds: number | null;
  /** Health one room's cycle is expected to take off the character, over what it can spawn. */
  damagePerRoom: number | null;
  /**
   * Health one room's cycle takes when it spawns the worst of what it can —
   * read over the mean, since a mean over three spawns hides the one that
   * takes the whole bar. Null while a spawn's rounds are unknown.
   */
  worstDamagePerRoom: number | null;
  /**
   * The least the worst spawn can cost, from the blows alone: a monster whose
   * rounds are unknown still swings for `perRound` over the shortest kill the
   * model allows (`LEAST_ROUNDS`). Equal to `worstDamagePerRoom` where every
   * spawn's rounds are known; a bound in the dangerous direction otherwise,
   * which is the one direction an exclusion may read a bound in. Null only
   * where no spawn's blows can be priced.
   */
  worstDamageAtLeast: number | null;
  /** Seconds the cycle spends meditating the mana back; 0 for a character that does not cast. */
  meditateSeconds: number | null;
  /** Casts of the heal a cycle spends instead of resting; 0 where resting is quicker or nothing heals. */
  healCasts: number | null;
  /** Seconds a cycle stands poisoned before the server allows a rest; 0 where nothing does. */
  poisonSeconds: number | null;
  /** `damagePerRoom / hpMax`. */
  damageShare: number | null;
  /** `worstDamagePerRoom / hpMax`. */
  worstShare: number | null;
  /** `worstDamageAtLeast / hpMax`: what *deadly* and *costly* are decided on. */
  worstShareAtLeast: number | null;
  /** Mean rounds per kill, the opener credited. */
  roundsPerKill: number | null;
  /** One room's cycle, at its worst spawn, takes at least the whole bar. */
  deadly: boolean;
  /** One room's worst spawn takes more than `maxDamageShare` of the bar: too dangerous to start in. */
  costly: boolean;
  /**
   * Not even the worst spawn could take `trivialShare` off an unarmoured
   * character: beneath this level. Decided only where every spawn's naked
   * figure is finished — a room with one spawn nobody can price is not
   * beneath anybody.
   */
  trivial: boolean;
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
 *
 * GreaterMUD's `Delay` of 0 is a clock too: the elapsed minutes are at once
 * past it, so the room is refilled at its next regen: the regen pass every
 * `roomRegenSeconds` for a room a player stands in (`RegenTickTime`, 121),
 * and on every entry (`Player.cs:782`, `inEnteringRoom.Regen`). Read here as
 * the pass, the clock for a character standing in it; a loop that re-enters
 * it is priced by `refillsOnEntry`. Paradigm states 0 for its lairs, which
 * left every spot on orohost without a rate.
 */
export function respawnSeconds(
  delay: number | null | undefined,
  family: RealmFamily | null,
  /** At the realm's speed (`atSpeed`); without `speed`, the server's own clocks. */
  constants: Pick<HuntingConstants, 'greatermudRespawnOffsetSeconds' | 'roomRegenSeconds'> &
    Partial<Pick<HuntingConstants, 'speed'>>,
  arena = false
): number | null {
  if (delay === null || delay === undefined || !Number.isFinite(delay)) return null;
  if (delay === 0) return refillsOnEntry(delay, family) ? constants.roomRegenSeconds : null;
  // The stated figure is in the server's own time, so a sped-up realm runs it faster.
  const nominal = (delay > 0 ? delay * (arena ? 1 : 60) : Math.abs(delay)) / (constants.speed ?? 1);
  if (family !== 'greatermud') return nominal;
  return Math.max(0, nominal - constants.greatermudRespawnOffsetSeconds);
}

/**
 * One step of a walk, in milliseconds, from the pack's weight.
 *
 * GreaterMUD's `MoveCommand.cs:40`: `1100 + (Encum / MaxEnc)² × 2000`, floored
 * at 1,000. Slowness and Quickness move it by their ability sums and are not on
 * the sheet, so this is the plain figure — a floor for a slowed character. The
 * two figures are the status line's `Encum:` pair. Any other family, or a pack
 * nobody has weighed, prices the measured `fallbackMs` rather than a formula
 * the client has not read off that server.
 */
export function moveDelayMs(
  encumbrance: number | null,
  encumbranceMax: number | null,
  family: RealmFamily | null,
  fallbackMs: number
): number {
  if (family !== 'greatermud') return fallbackMs;
  if (encumbrance === null || encumbranceMax === null || encumbranceMax <= 0) return fallbackMs;
  const share = Math.max(0, encumbrance) / encumbranceMax;
  return Math.max(1000, 1100 + Math.trunc(share * share * 2000));
}

/**
 * The shortest kill the model prices, in rounds: the floor under a stated
 * figure in `roomCycle`'s fight, and the kill a monster whose rounds are
 * unknown is charged for — so its blows still count against the bar, as a
 * bound in the dangerous direction.
 */
const LEAST_ROUNDS = 0.5;

/** The mean of the stated figures, or null when none is stated. */
function mean(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (known.length === 0) return null;
  return known.reduce((sum, value) => sum + value, 0) / known.length;
}

/** `a + b`, unknown when either is. */
function add(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

/** What one room costs and pays, before the loop is assembled. */
interface RoomCycle {
  spawns: number;
  /** Experience per room: every spawn's, summed. */
  experience: number | null;
  rounds: number | null;
  roundsPerKill: number | null;
  /** Expected over what the room can spawn. */
  damage: number | null;
  /** When it spawns the worst of them; null while a spawn's rounds are unknown. */
  worstDamage: number | null;
  /** The least the worst spawn can cost, each spawn charged its rounds or `LEAST_ROUNDS`. */
  worstDamageAtLeast: number | null;
  /** The worst spawn's, against an unarmoured character; null unless every spawn's is finished. */
  nakedDamage: number | null;
  /** Fighting time, the kill overhead included. */
  seconds: number | null;
  poisons: boolean;
  poisonSeconds: number | null;
}

/**
 * One room, fought: kill its `spawns` in turn (the pack ramps down — while the
 * k-th dies the rest are still swinging), a backstabber's opener credited as
 * `backstabMultiplier` rounds on the first blow — every kill in a room of
 * singles, the first of a pack. The same arithmetic against an unarmoured
 * character gives the figure the *beneath this level* test reads.
 */
function roomCycle(
  stated: number | null,
  mobs: readonly SpotMob[],
  character: SpotCharacter,
  c: HuntingConstants
): RoomCycle {
  const spawns = Math.max(1, stated ?? 1);
  const experience = mean(mobs.map((mob) => mob.experience));
  const rounds = mean(mobs.map((mob) => mob.rounds));
  const perRound = mean(mobs.map((mob) => mob.perRound));

  /*
   * The room's rounds and the ramp its pack dies down, for a kill of `rounds`
   * rounds: while the k-th dies the ones after it are still swinging.
   */
  const fight = (kill: number): { rounds: number; ramp: number } => {
    const plain = Math.max(LEAST_ROUNDS, kill);
    const opened = Math.max(LEAST_ROUNDS, 1 + Math.max(0, kill - c.backstabMultiplier));
    const perKill: number[] = [];
    for (let k = 0; k < spawns; k += 1) {
      const first = k === 0 || spawns === 1;
      perKill.push(character.backstab && first ? opened : plain);
    }
    return {
      rounds: perKill.reduce((sum, value) => sum + value, 0),
      ramp: perKill.reduce((sum, value, index) => sum + value * (spawns - index), 0)
    };
  };
  let roundsPerKill: number | null = null;
  let roomRounds: number | null = null;
  let damage: number | null = null;
  if (rounds !== null) {
    const expected = fight(rounds);
    roomRounds = expected.rounds;
    roundsPerKill = roomRounds / spawns;
    if (perRound !== null) damage = perRound * expected.ramp;
  }
  /*
   * And the worst the room can spawn, each monster fought for its own rounds:
   * a lair naming a ghost, a shadowraith and a crimson mist averaged to half
   * the bar and spawned, one visit in three, a monster that takes it whole.
   *
   * A monster whose rounds are unknown is not a monster that costs nothing:
   * its blows are known, and it swings them for at least the shortest kill
   * the model prices. So the exact figure waits for every spawn's rounds
   * while the floor is charged whatever is known — a level-one Mystic on a
   * stock realm, where the kill arithmetic is not this family's, was offered
   * a lair of bone warriors at 103 hp a round against a 33 hp bar because
   * the rounds were unknown and so, the survey concluded, was the danger.
   * The naked figure runs the other way: it decides *beneath this level*,
   * which is the reassuring answer, so one spawn unfinished leaves it
   * unfinished — except a spawn that cannot hit anybody, whose figure is
   * nought however long it stands there.
   */
  let worstDamage: number | null = null;
  let worstDamageAtLeast: number | null = null;
  let nakedDamage: number | null = null;
  let roundsComplete = true;
  let nakedComplete = true;
  for (const mob of mobs) {
    if (mob.rounds === null) roundsComplete = false;
    const { ramp } = fight(mob.rounds ?? LEAST_ROUNDS);
    if (mob.perRound !== null) {
      worstDamageAtLeast = Math.max(worstDamageAtLeast ?? 0, mob.perRound * ramp);
      if (mob.rounds !== null) worstDamage = Math.max(worstDamage ?? 0, mob.perRound * ramp);
    }
    if (mob.nakedPerRound === null || (mob.rounds === null && mob.nakedPerRound > 0)) {
      nakedComplete = false;
    } else {
      nakedDamage = Math.max(nakedDamage ?? 0, mob.nakedPerRound * ramp);
    }
  }
  if (!roundsComplete) worstDamage = null;
  if (!nakedComplete) nakedDamage = null;
  const seconds =
    roomRounds === null ? null : roomRounds * c.roundSeconds + (spawns * c.killOverheadMs) / 1000;

  let poisons = false;
  let poisonSeconds: number | null = 0;
  for (const mob of mobs) {
    for (const affliction of mob.afflictions) {
      if (affliction.kind !== 'poison') continue;
      poisons = true;
      if (poisonSeconds === null || affliction.seconds === null) poisonSeconds = null;
      else poisonSeconds = Math.max(poisonSeconds, affliction.seconds);
    }
  }

  return {
    spawns,
    experience: experience === null ? null : experience * spawns,
    rounds: roomRounds,
    roundsPerKill,
    damage,
    worstDamage,
    worstDamageAtLeast,
    nakedDamage,
    seconds,
    poisons,
    poisonSeconds
  };
}

/**
 * Whether a lair is refilled whenever a player walks in: GreaterMUD reads a
 * `Delay` of 0 as at once past (`RegenSlot.cs:53`), and runs the room's regen
 * on every entry (`Player.cs:782`). The one reading of the column's 0, for
 * `respawnSeconds` and the survey both.
 */
export function refillsOnEntry(
  delay: number | null | undefined,
  family: RealmFamily | null
): boolean {
  return delay === 0 && family === 'greatermud';
}

/**
 * A stop's clock on a lap of `stops` stops: a refilling room on a lap of two
 * or more is re-entered every time, so it has nothing to wait for (0); a
 * single room is never left, and keeps its clock (the regen pass). The one
 * rule the estimate prices by and the loop's stops are built by.
 */
export function lapClock(respawn: number, refills: boolean, stops: number): number;
export function lapClock(respawn: number | null, refills: boolean, stops: number): number | null;
export function lapClock(respawn: number | null, refills: boolean, stops: number): number | null {
  return refills && stops >= 2 ? 0 : respawn;
}

/** A spot's input with each refilling room's clock as the lap gives it (`lapClock`). */
function refilled(input: SpotInput): SpotInput {
  const stops = input.rooms + input.filler.length;
  return {
    ...input,
    respawnSeconds: lapClock(input.respawnSeconds, input.refillsOnEntry === true, stops),
    filler: input.filler.map((room) => ({
      ...room,
      respawnSeconds: lapClock(room.respawnSeconds, room.refillsOnEntry === true, stops)
    }))
  };
}

/** What one kill of a row pays, in the unit being weighed; null where unknown. */
type Worth = (mob: SpotMob) => number | null;
const EXPERIENCE: Worth = (mob) => mob.experience;
const COPPER: Worth = (mob) => mob.copper;

/**
 * One spot, estimated.
 *
 * The cycle: fight every room of the ring and each filler off it, walk the
 * ring and the detours, recover what the cycle cost past what standing
 * regained — by resting, or by casting the heal where that is quicker or
 * where poison refuses the rest — meditate the mana back, and if all that was
 * quicker than the primary lair's respawn, wait for it. A filler pays only
 * the share of visits that find it up. Nothing here is a prediction; it is
 * the realm's figures and the character's own, folded once, with every
 * unknown named.
 */
export function estimateSpot(given: SpotInput, c: HuntingConstants): SpotEstimate {
  const input = refilled(given);
  const unknown: HuntingUnknown[] = [];
  const rooms = Math.max(1, input.rooms);
  const ch = input.character;
  const stepMs = ch.stepMs ?? c.stepMs;

  const primary = roomCycle(input.spawns, input.mobs, ch, c);
  const fillers = input.filler.map((room) => ({
    ...roomCycle(room.spawns, room.mobs, ch, c),
    // Kept beside the fold so a filler's rows are weighed by their own clocks
    // exactly as the ring's are — see `weighed`.
    mobs: room.mobs,
    respawn: room.respawnSeconds,
    detour: Math.max(0, room.detourSteps)
  }));
  if (primary.experience === null) unknown.push('experience');
  if (primary.rounds === null) unknown.push('rounds');
  if (mean(input.mobs.map((mob) => mob.perRound)) === null) unknown.push('damage');
  if (input.respawnSeconds === null) unknown.push('respawn');
  if (ch.hpMax === null) unknown.push('health');

  /*
   * `damagePerRoom`/`worstDamagePerRoom` and the verdicts drawn off them are
   * the primary lair's alone and do not move with the cycle: they are what one
   * room costs to clear. The exclusions and *deadly* read the floor, which is
   * the worst figure where every spawn's rounds are known and a bound in the
   * dangerous direction where one is not — the only direction a bound may be
   * read in when the question is whether to send somebody there.
   */
  const hpMax = ch.hpMax;
  const damagePerRoom = primary.damage;
  const worstDamagePerRoom = primary.worstDamage;
  const worstDamageAtLeast = primary.worstDamageAtLeast;
  const share = (damage: number | null): number | null =>
    damage === null || hpMax === null || hpMax <= 0 ? null : damage / hpMax;
  const damageShare = share(damagePerRoom);
  const worstShare = share(worstDamagePerRoom);
  const worstShareAtLeast = share(worstDamageAtLeast);
  const floored = given.fightRun !== true && worstShareAtLeast !== null;
  const deadly = floored && worstShareAtLeast >= 1;
  const costly = floored && worstShareAtLeast > c.maxDamageShare;
  const trivial =
    primary.nakedDamage !== null &&
    hpMax !== null &&
    hpMax > 0 &&
    primary.nakedDamage < c.trivialShare * (1 - c.trivialLevelMargin) * hpMax;

  /**
   * The share of laps a filler is found standing: its clock against the
   * cycle's, and never more than all of them.
   *
   * `null` means *no cycle has been worked out yet*, and reads as the
   * primary's own clock — which the cycle is at least — exactly as `roomExp`
   * reads it. One sentinel with two meanings made the first pass charge every
   * filler whole, so the cycle it handed the second pass was too long and the
   * filler was then credited more laps than that cycle allows.
   */
  // A lair clock of 0 (refilled on the lap) says nothing about a window not yet worked out.
  const unworked = input.respawnSeconds === 0 ? null : input.respawnSeconds;
  const shareOf = (filler: { respawn: number }, window: number | null): number => {
    const seen = window ?? unworked;
    return seen === null ? 1 : Math.min(1, seen / Math.max(1, filler.respawn));
  };

  /**
   * A room's experience, with each row weighted by how often it is up.
   *
   * The model's experience is the **mean** over the rows a lair can spawn —
   * each equally likely — so a row on a clock of its own is worth the share of
   * visits that finds it back (todo 09): a 1,500-point Gravedigger on an
   * hour's regeneration pays a sixtieth of that per minute between visits, not
   * the whole of it. A row the realm gives no clock is on the room's and counts
   * whole.
   *
   * Every room goes through here, the ring's and the fillers' alike. Weighing
   * only `input.mobs` left the very failure this exists to end alive on the
   * filler path — and `addFiller` adds candidates by the rate they produce, so
   * those were the first rooms it reached for. A kill's copper is weighed the
   * same way (`worth`).
   */
  const weighed = (
    mobs: readonly SpotMob[],
    spawns: number,
    window: number | null,
    worth: Worth
  ): number | null => {
    const seen = window ?? unworked;
    const each = mean(
      mobs.map((mob) => {
        const paid = worth(mob);
        if (paid === null) return null;
        if (mob.regenSeconds === null || mob.regenSeconds <= 0 || seen === null) {
          return paid;
        }
        return paid * Math.min(1, seen / mob.regenSeconds);
      })
    );
    // However many the lair spawns at once.
    return each === null ? null : each * spawns;
  };

  /**
   * How long a filler's own rows have between two visits: the cycle, or the
   * filler's clock where that is longer. A room entered one lap in ten is
   * entered every ten laps, and ten laps is its clock — so a boss standing in
   * a filler is weighed against the wait the character actually gives it, not
   * against the ring's faster cycle.
   */
  const visitWindow = (filler: { respawn: number }, window: number | null): number | null => {
    const seen = window ?? unworked;
    return seen === null ? null : Math.max(seen, filler.respawn);
  };

  const primaryFor = (cycle: number | null, worth: Worth = EXPERIENCE): number | null => {
    const each = weighed(input.mobs, primary.spawns, cycle, worth);
    // Over every room of the ring — `roomCycle`'s own arithmetic, re-run with
    // the weights — and only for the fights won.
    return each === null ? null : each * rooms * (given.wins ?? 1);
  };

  /** What the fillers add to one cycle, each paid at the share it is found up. */
  const fillerFor = (window: number | null, worth: Worth = EXPERIENCE): number =>
    fillers.reduce((sum, filler) => {
      const paid = weighed(filler.mobs, filler.spawns, visitWindow(filler, window), worth);
      return paid === null ? sum : sum + paid * shareOf(filler, window);
    }, 0);

  /** What one pass of the model produced, priced against an assumed cycle. */
  interface Pass {
    walkSeconds: number;
    combatSeconds: number | null;
    restSeconds: number | null;
    meditateSeconds: number | null;
    poisonSeconds: number | null;
    healSeconds: number;
    healCasts: number | null;
    cycleSeconds: number | null;
    waitSeconds: number | null;
    expPerCycle: number | null;
    fillerExpPerCycle: number;
    expPerHour: number | null;
    unknown: HuntingUnknown[];
  }

  /**
   * One pass of the cycle, priced against an assumed one.
   *
   * A filler on a slower clock than the cycle is standing on only some laps,
   * and the loop a player actually walks turns aside for it only on those:
   * two rooms on a thirty-second clock and a third on a minute's is
   * `1,2,3,1,2,1,2,3`, not room 3 every lap and empty on half of them. So a
   * filler's detour, its fight, its wounds and its mana are every one of them
   * paid at the **same** share as its experience. Charging the walk and the
   * fight whole while paying a fifth of the kill priced a lap nobody would
   * walk, and it is the cost side that was wrong: the experience side has
   * been taking the share since the model was written.
   *
   * The share wants the cycle and the cycle wants the share, so the caller
   * runs this against the primary's clock — which the cycle is at least — and
   * then again against the cycle that came out, the way the experience side
   * has always been re-weighed.
   */
  const run = (window: number | null): Pass => {
    const unknownHere: HuntingUnknown[] = [];
    const walkSteps =
      Math.max(0, input.loopSteps) +
      fillers.reduce((sum, f) => sum + f.detour * shareOf(f, window), 0);
    const walkSeconds = (walkSteps * stepMs) / 1000;
    let combatSeconds: number | null = primary.seconds === null ? null : primary.seconds * rooms;
    let damagePerCycle: number | null = primary.damage === null ? null : primary.damage * rooms;
    let roundsPerCycle: number | null = primary.rounds === null ? null : primary.rounds * rooms;
    for (const filler of fillers) {
      const taken = shareOf(filler, window);
      combatSeconds = add(combatSeconds, filler.seconds === null ? null : filler.seconds * taken);
      damagePerCycle = add(damagePerCycle, filler.damage === null ? null : filler.damage * taken);
      roundsPerCycle = add(roundsPerCycle, filler.rounds === null ? null : filler.rounds * taken);
    }

    /*
     * Recovery. What standing regains — through the fight, the walk and any
     * poisoned wait — is taken off first; the remainder is paid sitting, at the
     * resting rate for health and the meditating rate for mana, which exclude
     * each other and so add. A heal is the other way to pay the health half:
     * `ceil(need / hpPerCast)` rounds of casting, its mana on the meditating
     * bill, and no poisoned wait, since casting is not refused where `rest` is.
     * The quicker recovery is the cycle's.
     */
    const passiveHp = (seconds: number): number =>
      ch.passiveHealthPerTick === null
        ? 0
        : (seconds / c.passiveTickSeconds) * ch.passiveHealthPerTick;
    const passiveMana = (seconds: number): number =>
      ch.passiveManaPerTick === null ? 0 : (seconds / c.passiveTickSeconds) * ch.passiveManaPerTick;
    const sit = (
      hpNeed: number,
      manaNeed: number,
      standing: number
    ): { rest: number | null; meditate: number | null } => {
      // Whole rest ticks, each with its share of the standing tick, which is always on.
      const ticks = (need: number, perRestTick: number | null, perStanding: number | null) =>
        perRestTick === null || perRestTick <= 0
          ? null
          : Math.ceil(
              need / (sittingPerSecond(perRestTick, perStanding ?? 0, c) * c.restTickSeconds)
            ) * c.restTickSeconds;
      const hp = Math.max(0, hpNeed - passiveHp(standing));
      const rest = hp === 0 ? 0 : ticks(hp, ch.restingHealthPerTick, ch.passiveHealthPerTick);
      const mana = Math.max(0, manaNeed - passiveMana(standing + (rest ?? 0)));
      const meditate =
        mana === 0 ? 0 : ticks(mana, ch.meditatingManaPerTick, ch.passiveManaPerTick);
      return { rest, meditate };
    };

    const manaPerRound = ch.manaPerRound !== null && ch.manaPerRound > 0 ? ch.manaPerRound : 0;
    const manaCombat = roundsPerCycle === null ? 0 : manaPerRound * roundsPerCycle;
    let restSeconds: number | null = null;
    let meditateSeconds: number | null = null;
    let healCasts: number | null = null;
    let healSeconds = 0;
    let poisonSeconds: number | null = 0;
    if (damagePerCycle !== null && combatSeconds !== null) {
      const standing = combatSeconds + walkSeconds;
      const owed = Math.max(0, damagePerCycle - passiveHp(standing));
      /*
       * A poisoning filler is not discounted by its share: it poisons on the
       * laps it is met, and a wait the character will sometimes stand is not
       * made shorter by averaging it over the laps it skips the room.
       */
      const poisoned = [primary, ...fillers].filter((room) => room.poisons);
      let wait: number | null = 0;
      if (owed > 0 && ch.poisonHoldsRest && poisoned.length > 0) {
        wait = poisoned.some((room) => room.poisonSeconds === null)
          ? null
          : Math.max(...poisoned.map((room) => room.poisonSeconds ?? 0));
      }
      const byRest = wait === null ? null : sit(damagePerCycle, manaCombat, standing + wait);
      let chosen: { rest: number | null; meditate: number | null } | null = byRest;
      poisonSeconds = wait;
      healCasts = 0;
      if (ch.heal !== null && ch.heal.hpPerCast > 0 && owed > 0) {
        const casts = Math.ceil(owed / ch.heal.hpPerCast);
        const castSeconds = casts * c.roundSeconds;
        const byHeal = sit(0, manaCombat + casts * ch.heal.manaPerCast, standing + castSeconds);
        const restTotal =
          byRest === null || byRest.rest === null || byRest.meditate === null
            ? null
            : (wait ?? 0) + byRest.rest + byRest.meditate;
        const healTotal = byHeal.meditate === null ? null : castSeconds + byHeal.meditate;
        if (healTotal !== null && (restTotal === null || healTotal < restTotal)) {
          chosen = { rest: 0, meditate: byHeal.meditate };
          healCasts = casts;
          healSeconds = castSeconds;
          poisonSeconds = 0;
        }
      }
      if (chosen === null) {
        unknownHere.push('poison');
        // A wait of unknown length: the rest cannot be timed, and the mana half
        // still can where nothing else is unknown.
        meditateSeconds = sit(0, manaCombat, standing).meditate;
      } else {
        restSeconds = chosen.rest;
        meditateSeconds = chosen.meditate;
        if (restSeconds === null) unknownHere.push('rest');
      }
      if (meditateSeconds === null) unknownHere.push('mana');
    } else if (manaCombat > 0) {
      meditateSeconds = sit(0, manaCombat, (combatSeconds ?? 0) + walkSeconds).meditate;
      if (meditateSeconds === null) unknownHere.push('mana');
    } else {
      meditateSeconds = 0;
    }

    /*
     * A filler pays the share of laps it is found up — the same share its
     * detour and its fight were charged at above.
     */
    const fillerExp = fillerFor(window);
    const primaryExp = primaryFor(window);

    let cycleSeconds: number | null = null;
    let waitSeconds: number | null = null;
    let expPerHour: number | null = null;
    let expPerCycle: number | null = primaryExp === null ? null : primaryExp + fillerExp;
    if (
      combatSeconds !== null &&
      restSeconds !== null &&
      meditateSeconds !== null &&
      poisonSeconds !== null &&
      input.respawnSeconds !== null &&
      primaryExp !== null &&
      !deadly
    ) {
      const active =
        combatSeconds + walkSeconds + poisonSeconds + restSeconds + healSeconds + meditateSeconds;
      cycleSeconds = Math.max(active, input.respawnSeconds);
      waitSeconds = cycleSeconds - active;
      expPerCycle = primaryExp + fillerExp;
      expPerHour = cycleSeconds > 0 ? (expPerCycle * 3600) / cycleSeconds : null;
    }
    return {
      walkSeconds,
      combatSeconds,
      restSeconds,
      meditateSeconds,
      poisonSeconds,
      healSeconds,
      healCasts,
      cycleSeconds,
      waitSeconds,
      expPerCycle,
      fillerExpPerCycle: fillerExp,
      expPerHour,
      unknown: unknownHere
    };
  };

  /*
   * Two passes: the first against the primary's clock, the second against the
   * cycle the first produced. Both the filler shares and the rows' own clocks
   * are re-weighed by it, which is what makes the answer the loop's own rather
   * than the lair's.
   */
  const first = run(null);
  const pass = first.cycleSeconds === null ? first : run(first.cycleSeconds);
  unknown.push(...pass.unknown);

  /*
   * The spawn-rate bound: what the lair pays if every kill were free, so the
   * cycle is the clock itself. `null` is the primary's clock throughout —
   * `shareOf` and `weighed` both read it that way — so a filler is credited
   * the laps that clock allows and no more. Credited whole, the bound came out
   * above the rate its own estimate called reachable, which is not a bound.
   */
  const ceilingExp = primaryFor(null);
  const ceilingFiller = fillerFor(null);
  const ceilingPerHour =
    ceilingExp === null || input.respawnSeconds === null || input.respawnSeconds <= 0
      ? null
      : ((ceilingExp + ceilingFiller) * 3600) / input.respawnSeconds;

  /*
   * The copper the same cycle's kills carry: the ring's and the fillers' rows
   * weighed by the window the exp was, a filler at the share it is found up.
   */
  const primaryCopper = primaryFor(first.cycleSeconds, COPPER);
  const copperPerCycle =
    primaryCopper === null ? null : primaryCopper + fillerFor(first.cycleSeconds, COPPER);
  const copperPerHour =
    copperPerCycle === null || pass.cycleSeconds === null || pass.cycleSeconds <= 0
      ? null
      : (copperPerCycle * 3600) / pass.cycleSeconds;

  return {
    expPerHour: pass.expPerHour,
    ceilingPerHour,
    expPerCycle: pass.expPerCycle,
    fillerExpPerCycle: pass.fillerExpPerCycle,
    copperPerCycle,
    copperPerHour,
    cycleSeconds: pass.cycleSeconds,
    combatSeconds: pass.combatSeconds,
    restSeconds: pass.restSeconds,
    walkSeconds: pass.walkSeconds,
    stepMs,
    waitSeconds: pass.waitSeconds,
    damagePerRoom,
    worstDamagePerRoom,
    worstDamageAtLeast,
    meditateSeconds: pass.meditateSeconds,
    healCasts: pass.healCasts,
    poisonSeconds: pass.poisonSeconds,
    damageShare,
    worstShare,
    worstShareAtLeast,
    roundsPerKill: primary.roundsPerKill,
    deadly,
    costly,
    trivial,
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
  /** A filler's own monsters, as the realm names them; absent on the lair's own rooms. */
  mobs?: string[];
  /** A filler's steps off the ring and back; absent on the lair's own rooms. */
  detour?: number;
  /**
   * Seconds until this room makes monsters again, where the realm states one.
   *
   * Carried on the room so `huntLoop` can put it on the stop it builds: the
   * runner walks a stop only when its clock has come round (`LoopStop.every`,
   * todo 15), which is what makes the lap earn the rate this survey priced —
   * a filler on a slower clock is priced as entered only on the laps it is
   * standing, and without this the lap walked its detour on every one.
   *
   * Absent where nothing states it. A stop with no clock is always due, so a
   * lair the realm says nothing about is walked exactly as it was.
   */
  respawnSeconds?: number;
}

/**
 * The order to walk a set of rooms in and what each leg costs: nearest
 * neighbour from the first room, closing back to it.
 *
 * `distance` is the sweep's own measurement between two rooms, or null where
 * one lies beyond the other's measured reach; then the leg is priced from the
 * two rooms' distances from the character — out to the farther and back — the
 * estimate the survey used before anything was measured. Greedy, so the first
 * `k` of the order are the ring a loop of `k` rooms walks, and `ringSteps(k)`
 * is its length.
 */
export function orderRing(
  rooms: readonly HuntingRoom[],
  distance: (from: RoomId, to: RoomId) => number | null
): { order: HuntingRoom[]; ringSteps: (rooms: number) => number } {
  const leg = (from: HuntingRoom, to: HuntingRoom): number =>
    distance(from.id, to.id) ?? Math.abs(to.steps - from.steps) + 2;
  const order: HuntingRoom[] = [];
  const legs: number[] = [];
  const left = [...rooms];
  let at = left.shift();
  while (at !== undefined) {
    order.push(at);
    if (left.length === 0) break;
    let pick = 0;
    let best = Number.POSITIVE_INFINITY;
    for (const [index, candidate] of left.entries()) {
      const cost = leg(at, candidate);
      if (cost < best) {
        best = cost;
        pick = index;
      }
    }
    legs.push(best);
    at = left.splice(pick, 1)[0];
  }
  const ringSteps = (count: number): number => {
    const k = Math.max(0, Math.min(count, order.length));
    if (k <= 1) return 0;
    const first = order[0]!;
    const last = order[k - 1]!;
    return legs.slice(0, k - 1).reduce((sum, value) => sum + value, 0) + leg(last, first);
  };
  return { order, ringSteps };
}

/**
 * How many of a lair's rooms the loop should visit.
 *
 * The rate climbs with every room until the cycle is at least the clock —
 * the wait is what the added room fills — and past it is flat but for the
 * rounding of rest ticks, since every room then brings its own fight, its
 * own rest and its own walk. So the answer is not the best rate, which the
 * rounding hands to whichever size happens to waste the least of a tick,
 * but the **fewest rooms** within `sizeTolerance` of it: the todo's *just
 * enough to meet the timing requirements*. The estimate is closed-form and
 * cheap, so every size is priced outright. Where no size yields a rate, the
 * most rooms, as the honest bound.
 */
export function sizeLoop(
  size: (rooms: number) => SpotInput,
  max: number,
  c: HuntingConstants
): { rooms: number; estimate: SpotEstimate } {
  const sizes: Array<{ rooms: number; estimate: SpotEstimate }> = [];
  for (let k = 1; k <= Math.max(1, max); k += 1)
    sizes.push({ rooms: k, estimate: estimateSpot(size(k), c) });
  let best: number | null = null;
  for (const { estimate } of sizes) {
    const rate = estimate.expPerHour;
    if (rate !== null && (best === null || rate > best)) best = rate;
  }
  if (best === null) return sizes[sizes.length - 1]!;
  const floor = best * (1 - Math.max(0, Math.min(1, c.sizeTolerance)));
  return sizes.find(
    ({ estimate }) => estimate.expPerHour !== null && estimate.expPerHour >= floor
  )!;
}

/**
 * Filler lairs, added one at a time while each raises the rate.
 *
 * The primary's clock leaves the cycle waiting; a lair beside the ring can
 * be fought in that wait for nothing but its walk. Candidates come nearest
 * first, each is priced in place, and the first that lowers the rate ends
 * the adding — beyond the wait every filler is walked at the primary's
 * expense. Never past `maxRooms` rooms in all, and never on a spot whose
 * rate is unknown, since there is nothing to improve.
 *
 * Under a cash floor (`automation.hunting.cashPerHour`, todo 64) a lair that
 * raises the copper is taken too while the loop pays less than the floor, past
 * the wait and at the exp's expense: that is what the floor asks for.
 */
export function addFiller(
  input: SpotInput,
  candidates: readonly FillerInput[],
  maxRooms: number,
  c: HuntingConstants,
  cashPerHour = 0
): { input: SpotInput; estimate: SpotEstimate; taken: number[] } {
  let current = input;
  let estimate = estimateSpot(current, c);
  const taken: number[] = [];
  if (estimate.expPerHour === null) return { input: current, estimate, taken };
  for (const [index, candidate] of candidates.entries()) {
    if (current.rooms + current.filler.length >= maxRooms) break;
    const short = shortOfCash(estimate.copperPerHour, cashPerHour);
    if ((estimate.waitSeconds ?? 0) <= 0 && !short) break;
    const next: SpotInput = { ...current, filler: [...current.filler, candidate] };
    const priced = estimateSpot(next, c);
    if (priced.expPerHour === null) continue;
    const moreExp = priced.expPerHour > estimate.expPerHour!;
    const moreCash = short && (priced.copperPerHour ?? 0) > (estimate.copperPerHour ?? 0);
    if (!moreExp && !moreCash) continue;
    current = next;
    estimate = priced;
    taken.push(index);
  }
  return { input: current, estimate, taken };
}

/**
 * What makes a room a hunting ground: a lair the world database states, a
 * placed monster (`Rooms.NPC`), or refills timed on the wire in a room the
 * database gives neither (`spawns.ts`).
 */
export type HuntVia = 'lair' | 'resident' | 'seen';

/** How the survey is asked: for the character as it stands or as `as`, and what it keeps that it would leave out. */
export interface SurveyAsk {
  as?: CharacterState;
  /** The spots beneath this level, marked `estimate.trivial`. */
  beneath?: boolean;
  /** The spots the level ready would shut once trained, marked `closesWithTraining`. */
  gated?: boolean;
  /**
   * Which `maxSpots` of the ranked guesses are measured: 0, the default, the
   * best; 1 the next, and so on. The rest come back in `unmeasured`.
   */
  page?: number;
  /**
   * Spots measured on the first page wherever their guess ranks: the ones an
   * extension has been paid by. Every spot measured at this level is already.
   */
  measure?: readonly string[];
}

/** One suggestion: a lair, the rooms that hold it, and what it is worth. */
export interface HuntingSpot {
  /** The lair's signature, stable across asks. */
  key: string;
  via: HuntVia;
  /** The monsters, as the realm names them. */
  mobs: SpotMob[];
  /**
   * Where the clock came from: the room's `Delay`, a placed monster's
   * `RegenTime`, its refills timed on the wire (`timed`), or, for a lair not
   * yet timed, the realm's usual timed lair clock (`usual`). See `spawns.ts`.
   */
  clock: 'delay' | 'regenTime' | 'timed' | 'usual' | null;
  /** A placed monster on its own clock — a boss, whose kill is not repeatable within it. */
  boss: boolean;
  respawnSeconds: number | null;
  spawns: number | null;
  /** The lair's own rooms the loop visits, in walking order. */
  rooms: HuntingRoom[];
  /** Lairs beside the ring, fought while the clock runs. */
  filler: HuntingRoom[];
  /** Every stop in walking order — the ring with each filler after the room it hangs off. */
  walk: HuntingRoom[];
  /** How many rooms in the realm hold this lair, the loop's or not. */
  roomCount: number;
  /** Steps round the ring and along every detour, as measured. */
  loopSteps: number;
  /**
   * With a level ready to train, training it shuts the way back here (a lair
   * behind an exit for levels up to the current one, such as `Level: 0 to
   * 5`). Set only where the survey was asked to keep such grounds (`gated`);
   * otherwise they are left out and counted.
   */
  closesWithTraining?: true;
  estimate: SpotEstimate;
}

/** What the model assumed, so the reader can weigh the answer. */
export interface HuntingAssumptions {
  family: RealmFamily | null;
  hpMax: number | null;
  restingHealthPerTick: number | null;
  /**
   * Health regained per standing tick (`DoHPTick`, every
   * `constants.passiveTickSeconds`, resting, fighting or walking), a floor
   * until `stat all` states it; null where the sheet does not state it and the
   * family's arithmetic cannot give it. A tick that comes at full health adds
   * nothing.
   */
  passiveHealthPerTick: number | null;
  backstab: boolean;
  stepMs: number;
  heal: HealingCast | null;
  poisonHoldsRest: boolean;
  /**
   * This character's own damage a round, off its fight record, where the
   * realm's arithmetic could not price a kill — null where it could, or where
   * the record is too thin (`tuning.hunting.measuredFightsMin`).
   */
  measured: MeasuredOutput | null;
  constants: HuntingConstants;
}

/** What the survey left out before ranking, counted by reason. */
export interface HuntExclusions {
  dangerous: number;
  beneath: number;
  unsurvivable: number;
  unsimulated: number;
  evil: number;
  /** Behind a gate the next level shuts, with that level ready to train (todo 71). */
  gated: number;
}

/** Nothing left out. */
export const NO_EXCLUSIONS: Readonly<HuntExclusions> = {
  dangerous: 0,
  beneath: 0,
  unsurvivable: 0,
  unsimulated: 0,
  evil: 0,
  gated: 0
};

export interface HuntingAdvice {
  /** Where the sweep started, or null when the character is unplaced. */
  from: { id: RoomId; name: string } | null;
  /** How far it looked, in steps; null is everywhere the exits reach. */
  radius: number | null;
  /** How many rooms it reached. */
  swept: number;
  /** The best `maxSpots`, measured: what automatic hunting chooses among. */
  spots: HuntingSpot[];
  /**
   * Every other lair it reached and did not leave out, on the first estimate:
   * the loop is the nearest rooms in distance order, with no filler. Listed so
   * the answer is the realm; never walked unasked.
   */
  unmeasured: HuntingSpot[];
  /**
   * What was left out before the ranking, and why. `unsurvivable` is a lair
   * whose fight at full health is survived no more often than the safe level
   * (`OddsBook`, todo 03); `unsimulated` one whose fight has not been run yet;
   * `evil` one where every monster costs evil points to attack.
   */
  excluded: HuntExclusions;
  assumptions: HuntingAssumptions;
  /** The cash floor the spots were ranked against (`automation.hunting.cashPerHour`, `cashFloor`). */
  floor: CashFloor;
  /** Measured over estimated where both are known, scaling every unhunted ground; null before any (`withMeasured`). */
  pace: number | null;
  /** Why there is no answer, said out loud. */
  refusal: string | null;
}

/**
 * Whether a spot sits in the nearest-first tier: no rate, not deadly, and the
 * fight itself unpriced — the rounds, or the blows, unknown for every spawn.
 * The card's head counts the rows this is true of, so it is the tier and not
 * a part of it: a lair with one spawn priced and one not has a rate and a
 * floor, and is ranked on the rate.
 */
export function fightUnpriced(
  estimate: Pick<SpotEstimate, 'expPerHour' | 'deadly' | 'unknown'>
): boolean {
  return (
    estimate.expPerHour === null &&
    !estimate.deadly &&
    (estimate.unknown.includes('rounds') || estimate.unknown.includes('damage'))
  );
}

/**
 * The order the reader wants: a known rate first, highest first; then a
 * spot whose rate could not be finished but whose fight was priced, by what
 * one sweep earns and then its ceiling; then a spot whose fight nobody could
 * price, nearest first and never by what it pays; a deadly spot last,
 * whatever it pays. An unknown rate is never a high one.
 *
 * The third tier is the whole card on a realm whose kill arithmetic is not
 * known (`prowess.swing` answers null off the GreaterMUD lineage): ordered by
 * the sweep, the top of a level-one character's list was ten bone warriors
 * at 270,000 a room, because the biggest reward with no cost beside it is
 * the most dangerous room in reach. Nearest is the one fact the character
 * has about every one of them.
 */
export function compareSpots(a: HuntingSpot, b: HuntingSpot, floor: CashFloor = NO_FLOOR): number {
  const rank = (spot: HuntingSpot): number =>
    spot.estimate.deadly ? 3 : spotRate(spot) !== null ? 0 : fightUnpriced(spot.estimate) ? 2 : 1;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) {
    /*
     * Under a cash floor: a spot paying it first, then those short of it by
     * copper, then the rest by exp. Copper counts only where the exp is within
     * `expAtLeast` of the best (todo 71): a floor nothing paid ranked the realm
     * by copper alone and dropped a cave bear earning 56k an hour.
     */
    const ta = cashTier(spotRate(a), a.estimate.copperPerHour, floor);
    const tb = cashTier(spotRate(b), b.estimate.copperPerHour, floor);
    if (ta !== tb) return ta - tb;
    if (ta === 1) {
      const cash = (b.estimate.copperPerHour ?? 0) - (a.estimate.copperPerHour ?? 0);
      if (cash !== 0) return cash;
    }
    const d = (spotRate(b) ?? 0) - (spotRate(a) ?? 0);
    if (d !== 0) return d;
  } else if (ra !== 2) {
    /*
     * Where no rate could be finished, what one sweep of the lair earns
     * (`expPerCycle`, over its rooms) is the better bet, then the ceiling as a
     * tiebreak. A ceiling is a bound, not an estimate: a single 500-point
     * monster on a one-hour clock is *at most* 500 an hour, and it outranked
     * eight rooms of sewer monsters three steps away only because their rooms
     * carry no clock — the lair the same character then earned 5–8k an hour in
     * (todo 108, 2026-09-13).
     */
    const sweep = (b.estimate.expPerCycle ?? -1) - (a.estimate.expPerCycle ?? -1);
    if (sweep !== 0) return sweep;
    const ceiling = (b.estimate.ceilingPerHour ?? -1) - (a.estimate.ceilingPerHour ?? -1);
    if (ceiling !== 0) return ceiling;
  }
  return (a.rooms[0]?.steps ?? 0) - (b.rooms[0]?.steps ?? 0);
}

/**
 * The copper an hour the hunt is asked for, and the least exp an hour a spot
 * must pay for its copper to count: `expShare` of the best rate offered.
 */
export interface CashFloor {
  copperPerHour: number;
  expAtLeast: number;
}

/** No floor: spots rank by exp alone. */
export const NO_FLOOR: Readonly<CashFloor> = { copperPerHour: 0, expAtLeast: 0 };

/**
 * Where a spot stands under a floor: 0 paying it (or no floor), 1 short of it
 * with exp enough for its copper to count, 2 too little exp for copper to count.
 * Within 0 and 2 the exp decides; within 1 the copper.
 */
export function cashTier(exp: number | null, copper: number | null, floor: CashFloor): 0 | 1 | 2 {
  if (floor.copperPerHour <= 0) return 0;
  if ((exp ?? 0) < floor.expAtLeast) return 2;
  return shortOfCash(copper, floor.copperPerHour) ? 1 : 0;
}

/** A spot's exp an hour as ranked: what it measured where it was hunted, else the estimate. */
export function spotRate(spot: HuntingSpot): number | null {
  return spot.estimate.measured?.perHour ?? spot.estimate.expPerHour;
}

/** What hunting one spot paid a character, as kept between sessions (todo 70). */
export interface MeasuredRate {
  perHour: number;
  minutes: number;
  /**
   * The level it was measured at. The rate prices only this level; its ratio
   * to `estimated` prices a level within `measuredLevels` of it.
   */
  level: number;
  at: number;
  /**
   * The model's own figure for the spot when it was measured
   * (`SpotEstimate.modelPerHour`). The rate's ratio to it prices the spot at a
   * level within `measuredLevels` of this one. Absent on a rate kept before it
   * was recorded.
   */
  estimated?: number | null;
}

export interface MeasuredUse {
  level: number | null;
  now: number;
  /** A measurement older than this says nothing (`tuning.hunting.measuredForgetMs`). */
  forgetMs: number;
  /** A stay shorter than this is the walk in, not the rate (`tuning.hunting.measuredMinutesLeast`). */
  minutesLeast: number;
  /** The bounds on the pace: one strange ground does not rescale the realm. */
  paceLeast: number;
  paceMost: number;
  /** How many levels away a rate's ratio to its estimate still prices a spot (`tuning.hunting.measuredLevels`). */
  levelsAcross: number;
}

/**
 * The survey with what was measured (todo 70): a spot hunted at this level
 * carries its measured rate; a spot hunted within `levelsAcross` levels is
 * scaled by its own ratio of measured to the model's figure; every other
 * spot's hourly figures are scaled by the pace, the median of measured over
 * estimated at this level, or of those carried ratios while nothing is
 * measured here yet. The model's arithmetic assumes the server's round and
 * the database's experience; a realm run faster (orohost runs about five
 * times) or paying more per kill measures above it, and the pace carries that
 * to the grounds not yet hunted. Pure.
 */
export function withMeasured(
  spots: readonly HuntingSpot[],
  rates: ReadonlyMap<string, MeasuredRate>,
  use: MeasuredUse
): { spots: HuntingSpot[]; pace: number | null } {
  const fresh = (rate: MeasuredRate | undefined): rate is MeasuredRate =>
    rate !== undefined && use.now - rate.at < use.forgetMs && rate.minutes >= use.minutesLeast;
  const valid = (rate: MeasuredRate | undefined): rate is MeasuredRate =>
    fresh(rate) && use.level !== null && rate.level === use.level;
  const bound = (ratio: number): number => Math.min(use.paceMost, Math.max(use.paceLeast, ratio));
  /*
   * Within `levelsAcross` levels of the one it was measured at, a rate prices
   * its spot by its ratio to the model's figure it was measured beside, so a
   * ground that paid three times its estimate at level 12 is not priced at the
   * bare estimate at 13 (2026-10-06, from the records of 10-03 to 10-05:
   * Soul's Straw-Floored Passage, measured at 3.3 times its estimate at three
   * levels, lost each new level to a spot that paid two thirds of its own).
   */
  const carried = (rate: MeasuredRate | undefined): number | null => {
    if (!fresh(rate) || use.level === null || rate.level === use.level) return null;
    if (Math.abs(rate.level - use.level) > use.levelsAcross) return null;
    const was = rate.estimated ?? null;
    return was === null || was <= 0 ? null : bound(rate.perHour / was);
  };
  const ratios: number[] = [];
  const across: number[] = [];
  for (const spot of spots) {
    const rate = rates.get(spot.key);
    const estimated = spot.estimate.expPerHour;
    if (valid(rate) && estimated !== null && estimated > 0) ratios.push(rate.perHour / estimated);
    const ratio = carried(rate);
    if (ratio !== null) across.push(ratio);
  }
  // Nothing measured at this level yet: the realm's pace is read off the levels beside it.
  const middle = median(ratios.length > 0 ? ratios : across);
  const pace = middle === null ? null : bound(middle);
  const by =
    (factor: number | null) =>
    (value: number | null): number | null =>
      value === null || factor === null ? value : value * factor;
  return {
    pace,
    spots: spots.map((spot) => {
      const rate = rates.get(spot.key);
      const modelled = {
        ...spot.estimate,
        modelPerHour: spot.estimate.modelPerHour ?? spot.estimate.expPerHour
      };
      if (valid(rate)) {
        return {
          ...spot,
          estimate: {
            ...modelled,
            measured: { perHour: rate.perHour, minutes: rate.minutes, at: rate.at }
          }
        };
      }
      const scaled = by(carried(rate) ?? pace);
      return {
        ...spot,
        estimate: {
          ...modelled,
          expPerHour: scaled(spot.estimate.expPerHour),
          ceilingPerHour: scaled(spot.estimate.ceilingPerHour),
          copperPerHour: scaled(spot.estimate.copperPerHour)
        }
      };
    })
  };
}

/** The floor against a best exp rate: copper counts only within `expShare` of it. */
export function floorFor(copperPerHour: number, bestExp: number, expShare: number): CashFloor {
  return copperPerHour <= 0 ? NO_FLOOR : { copperPerHour, expAtLeast: bestExp * expShare };
}

/** The floor over these spots, against the best exp rate among them. */
export function cashFloor(
  spots: readonly HuntingSpot[],
  copperPerHour: number,
  expShare: number
): CashFloor {
  let best = 0;
  for (const spot of spots) {
    const exp = spotRate(spot);
    if (!spot.estimate.deadly && exp !== null && exp > best) best = exp;
  }
  return floorFor(copperPerHour, best, expShare);
}

/**
 * Whether a spot paying `copperPerHour` pays less than the hunt is asked for. No
 * floor (0) is never short; an unknown copper figure is none.
 */
export function shortOfCash(copperPerHour: number | null, cashPerHour: number): boolean {
  return cashPerHour > 0 && (copperPerHour ?? 0) < cashPerHour;
}

/**
 * The monster a spot's loop is *for*: the one that pays most, else the
 * realm's first row. Unknown experience never outranks a stated figure.
 */
export function primaryMob(spot: HuntingSpot): string {
  let best = spot.mobs[0];
  for (const mob of spot.mobs) {
    if (mob.experience !== null && (best?.experience ?? -1) < mob.experience) best = mob;
  }
  return best?.name ?? '';
}

/**
 * What a spot's loop is called: the place it starts and what it is for.
 *
 * The realm carries no area names — `Rooms` has a map number and a room name
 * and nothing between — so the place is the first room's own name.
 *
 * Here rather than in the card because the card is no longer the only caller:
 * `AutoHunt` builds the same loop without one, and a loop the player started
 * by hand and one the client started on its own must not be called different
 * things.
 */
export function loopNameOf(spot: HuntingSpot, t: UiLookup): string {
  return t('cards.hunting.loopName', { area: spot.walk[0]?.name ?? '', mob: primaryMob(spot) });
}

/**
 * The loop a suggestion would walk, in the stop grammar every loop uses.
 *
 * Never filed: it is built from the survey each time, so a lair that stops
 * being worth walking is not left on a shelf under a name that promises it is.
 */
export function huntLoop(spot: HuntingSpot, t: UiLookup): Loop {
  return {
    name: loopNameOf(spot, t),
    /*
     * Each stop carries the clock of the room it names (todo 15): the lair's
     * own for a room of the ring, and the filler's own for one hanging off it.
     * That is what lets the runner walk a slow filler only on the laps it is
     * standing — which is how this survey priced it (`addFiller`), and the
     * difference between the rate the card promises and the rate the lap
     * earns. A room the realm states no clock for gets none, and a stop with
     * no clock is always due.
     */
    stops: spot.walk.map((room) => huntStop(room, room.respawnSeconds ?? spot.respawnSeconds))
  };
}

/** A room as a loop stop, with its clock where it has one: a stop with no clock is always due. */
export function huntStop(room: HuntingRoom, clock: number | null | undefined): LoopStop {
  return {
    room: `${room.name} ${room.map}/${room.room}`,
    ...(clock === null || clock === undefined || clock <= 0 ? {} : { every: Math.round(clock) })
  };
}

/**
 * A hunt planned outside the survey's own choice (an extension's): the loop
 * to run, the room it starts in, the spot whose fight it mostly is, and what
 * it was priced at. `key` is what the order is known by: the same key again
 * is the same hunt.
 */
export interface HuntOrder {
  key: string;
  loop: Loop;
  start: HuntingRoom;
  spot: HuntingSpot;
  expPerHour: number | null;
  copperPerHour: number | null;
  /**
   * Walked to the start as a run (todo 15): combat off for the way, steps
   * timed between rounds, combat on again at arrival. Absent is a walk that
   * fights what it meets. `runRisk` prices the way.
   */
  run?: boolean;
}

/**
 * What holds a hunt from setting off (`AutoHunt.waiting`): a fight, a walk or
 * a move under way, another errand, health under the resting floor, a lap
 * that is not the hunt's, the steered spot's lair not yet simulated.
 */
export type HuntWait = 'fight' | 'walking' | 'busy' | 'hurt' | 'lap' | 'simulating';
