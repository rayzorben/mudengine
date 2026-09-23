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
import type { MeasuredOutput } from './fights';
import type { UiLookup } from './i18n';
import type { Loop } from './loops';
import type { MobAffliction } from './menace';
import type { RealmFamily } from './realm';
import type { RoomId } from './world';

/** The figures the model runs on. `tuning.hunting`, handed in whole. */
export interface HuntingConstants {
  roundSeconds: number;
  restTickSeconds: number;
  passiveTickSeconds: number;
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

/** One monster a spot spawns, priced against the character. */
export interface SpotMob {
  name: string;
  /** `Monsters.EXP`, or null where the realm states none. */
  experience: number | null;
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
  /** The spawn-rate bound: what the lair pays if every kill were free. */
  ceilingPerHour: number | null;
  expPerCycle: number | null;
  /** What the filler rooms add to a cycle's experience, at the share of visits that find them up. */
  fillerExpPerCycle: number;
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
export function estimateSpot(input: SpotInput, c: HuntingConstants): SpotEstimate {
  const unknown: HuntingUnknown[] = [];
  const rooms = Math.max(1, input.rooms);
  const ch = input.character;
  const stepMs = ch.stepMs ?? c.stepMs;

  const primary = roomCycle(input.spawns, input.mobs, ch, c);
  const fillers = input.filler.map((room) => ({
    ...roomCycle(room.spawns, room.mobs, ch, c),
    // Kept beside the fold so a filler's rows are weighed by their own clocks
    // exactly as the ring's are — see `weighedExp`.
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
  const deadly = worstShareAtLeast !== null && worstShareAtLeast >= 1;
  const costly = worstShareAtLeast !== null && worstShareAtLeast > c.maxDamageShare;
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
  const shareOf = (filler: { respawn: number }, window: number | null): number => {
    const seen = window ?? input.respawnSeconds;
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
   * those were the first rooms it reached for.
   */
  const weighedExp = (
    mobs: readonly SpotMob[],
    spawns: number,
    window: number | null
  ): number | null => {
    const seen = window ?? input.respawnSeconds;
    const each = mean(
      mobs.map((mob) => {
        if (mob.experience === null) return null;
        if (mob.regenSeconds === null || mob.regenSeconds <= 0 || seen === null) {
          return mob.experience;
        }
        return mob.experience * Math.min(1, seen / mob.regenSeconds);
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
    const seen = window ?? input.respawnSeconds;
    return seen === null ? null : Math.max(seen, filler.respawn);
  };

  const primaryExpFor = (cycle: number | null): number | null => {
    const each = weighedExp(input.mobs, primary.spawns, cycle);
    // Over every room of the ring — `roomCycle`'s own arithmetic, re-run with
    // the weights.
    return each === null ? null : each * rooms;
  };

  /** What the fillers add to one cycle, each paid at the share it is found up. */
  const fillerExpFor = (window: number | null): number =>
    fillers.reduce((sum, filler) => {
      const paid = weighedExp(filler.mobs, filler.spawns, visitWindow(filler, window));
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
      const hp = Math.max(0, hpNeed - passiveHp(standing));
      const rest =
        hp === 0
          ? 0
          : ch.restingHealthPerTick === null || ch.restingHealthPerTick <= 0
            ? null
            : Math.ceil(hp / ch.restingHealthPerTick) * c.restTickSeconds;
      // The standing rate ticks through a rest as well: the server's passive
      // tick is always on, and a rest is only the health rate tripled.
      const mana = Math.max(0, manaNeed - passiveMana(standing + (rest ?? 0)));
      const meditate =
        mana === 0
          ? 0
          : ch.meditatingManaPerTick === null || ch.meditatingManaPerTick <= 0
            ? null
            : Math.ceil(mana / ch.meditatingManaPerTick) * c.restTickSeconds;
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
    const fillerExp = fillerExpFor(window);
    const primaryExp = primaryExpFor(window);

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
   * `shareOf` and `weighedExp` both read it that way — so a filler is credited
   * the laps that clock allows and no more. Credited whole, the bound came out
   * above the rate its own estimate called reachable, which is not a bound.
   */
  const ceilingExp = primaryExpFor(null);
  const ceilingFiller = fillerExpFor(null);
  const ceilingPerHour =
    ceilingExp === null || input.respawnSeconds === null || input.respawnSeconds <= 0
      ? null
      : ((ceilingExp + ceilingFiller) * 3600) / input.respawnSeconds;

  return {
    expPerHour: pass.expPerHour,
    ceilingPerHour,
    expPerCycle: pass.expPerCycle,
    fillerExpPerCycle: pass.fillerExpPerCycle,
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
 */
export function addFiller(
  input: SpotInput,
  candidates: readonly FillerInput[],
  maxRooms: number,
  c: HuntingConstants
): { input: SpotInput; estimate: SpotEstimate; taken: number[] } {
  let current = input;
  let estimate = estimateSpot(current, c);
  const taken: number[] = [];
  if (estimate.expPerHour === null) return { input: current, estimate, taken };
  for (const [index, candidate] of candidates.entries()) {
    if (current.rooms + current.filler.length >= maxRooms) break;
    if ((estimate.waitSeconds ?? 0) <= 0) break;
    const next: SpotInput = { ...current, filler: [...current.filler, candidate] };
    const priced = estimateSpot(next, c);
    if (priced.expPerHour === null || priced.expPerHour <= estimate.expPerHour!) continue;
    current = next;
    estimate = priced;
    taken.push(index);
  }
  return { input: current, estimate, taken };
}

/** One suggestion: a lair, the rooms that hold it, and what it is worth. */
export interface HuntingSpot {
  /** The lair's signature, stable across asks. */
  key: string;
  /** The monsters, as the realm names them. */
  mobs: SpotMob[];
  /** Where the clock came from: the room's `Delay`, or a placed monster's `RegenTime`. */
  clock: 'delay' | 'regenTime' | null;
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
  estimate: SpotEstimate;
}

/** What the model assumed, so the reader can weigh the answer. */
export interface HuntingAssumptions {
  family: RealmFamily | null;
  hpMax: number | null;
  restingHealthPerTick: number | null;
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
  /** What was left out before the ranking, and why. */
  excluded: { dangerous: number; beneath: number };
  assumptions: HuntingAssumptions;
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
export function compareSpots(a: HuntingSpot, b: HuntingSpot): number {
  const rank = (spot: HuntingSpot): number =>
    spot.estimate.deadly
      ? 3
      : spot.estimate.expPerHour !== null
        ? 0
        : fightUnpriced(spot.estimate)
          ? 2
          : 1;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) {
    const d = b.estimate.expPerHour! - a.estimate.expPerHour!;
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
    stops: spot.walk.map((room) => {
      const clock = room.respawnSeconds ?? spot.respawnSeconds;
      return {
        room: `${room.name} ${room.map}/${room.room}`,
        ...(clock === null || clock === undefined || clock <= 0 ? {} : { every: Math.round(clock) })
      };
    })
  };
}
