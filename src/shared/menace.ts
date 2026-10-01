/**
 * What a monster is going to cost this character, and which of several to
 * hit first.
 *
 * Auto-combat used to take monsters in the order the room listed them, which
 * is the order the server printed and therefore the only order the client had
 * any reason to believe in — until the realm data could say how each one
 * fights. It can now (format 20): five attack slots with accuracy, damage,
 * energy and an on-hit spell, the spells cast between rounds with their odds
 * and cast level, and the spell cast on death. Against the character's own
 * armour class, damage resistance and magic resistance off the stat sheet,
 * that is enough to say how many hit points a round beside each monster is
 * expected to cost — so the client can kill the expensive one first.
 *
 * ## The arithmetic is the server's, not a heuristic
 *
 * Every formula here is transcribed from the GreaterMUD source and says which
 * routine it came from. `Mob.DoCombat` rolls a slot, spends its energy, rolls
 * to hit against `(AC / 10)²` over `(Acc² / 14) / 10`, takes `DR / 10` off the
 * blow, and applies the slot's hit spell when damage lands; the between-round
 * loop in `TimedEventManager` makes one roll per monster per round;
 * `Spell.RollAndApplySpellAbilities` scales power by cast level to the cap,
 * applies a damage ability on the cast and on every three-second effect tick
 * for the spell's duration, and lets a target's magic resistance turn a
 * resistable cast away. Where the server's reading and the wire disagree the
 * wire wins. One capture has checked the blows (todo 00, 2026-09-23: the
 * leader's 7 of 40 against 30%, a raider's 15 of 561 against 0–22% by row),
 * and the trace prints the figures so a person can see what they were.
 *
 * ## What a hazard is worth
 *
 * A blow is hit points and needs no conversion. Paralysis, confusion, fear
 * and a summoned ally are not, and the unit they are converted into is **one
 * round of the whole room's blows against this character** — because that is
 * what a round spent unable to leave actually costs: everything else in the
 * room keeps swinging. The multipliers are judgement, and they live in
 * `tuning.menace` (`internal.yaml`) rather than here, so somebody who thinks a
 * round held is worth two rounds of damage can say so without a rebuild. The
 * unit has a floor for a room of pure casters, where a round of blows is
 * nothing and a round of paralysis still is not.
 *
 * ## Why the order is menace per hit point, not menace
 *
 * Two monsters, one doing 30 a round with 100 health and one doing 50 a round
 * with 3,000: the obvious order is the 50 first, and it is wrong. Killing the
 * small one takes a round or two and removes its 30 from every one of the
 * thirty rounds the big one then takes; killing the big one first means
 * taking both for thirty rounds. Minimising the damage absorbed over the whole
 * fight is ordering by *rate over time-to-remove* — Smith's rule — and the
 * time to remove a monster is proportional to its health. Whether the big
 * one kills the character in three rounds is the retreat threshold's question
 * and not this one's: no order helps with that.
 *
 * ## What the character's side contributes, and what it cannot
 *
 * The stat sheet's `Armour Class`, `Damage Resist` and `Magic Res` are the
 * exact figures the server divides its internal values down to
 * (`StatCommand` prints `AC / 10` and `DR / 10`), so a blow's hit chance and
 * size are computed as the server would, with the protection the sheet does
 * not print (`protectionOf`) and the dodge its figures give (`prowess.dodge`)
 * added as `Mob.DoCombat` adds them; a maximum not yet read is taken as the figure that makes
 * every blow land, because **unknown is never the reassuring answer**. The
 * character's own damage output is not known to the client at all, so the
 * time to kill is health alone; a factor equal for every monster in a room
 * changes no order.
 *
 * Dependency-free, like everything here: `AutoCombat` hands it the room and
 * the sheet, and the trace prints what came back.
 */
import { HAZARD_ABILITY, PROTECTION_ABILITY } from './abilities';
import type { ActiveBuff, CharacterState } from './character';
import type { MobEntity } from './entities';
import type { MobAttack, MobProfile, WorldSpell } from './world';

/**
 * What of a monster's entity the weighing reads. An occupant the tracker
 * could attach no entity to weighs as `{}`: nothing known, which is `null`.
 */
export type MenaceSubject = Pick<MobEntity, 'hp' | 'deathSpell' | 'profiles' | 'spells'> &
  Partial<Pick<MobEntity, 'disposition' | 'uncertain' | 'costly'>>;

/** The sheet figures a blow or a cast is measured against. Null is *not read yet*. */
export interface MenacePlayer {
  armourClass: number | null;
  damageResist: number | null;
  magicRes: number | null;
  /**
   * What `Mob.DoCombat` adds to the armour class before the roll, in the
   * sheet's units — `secondaryDefense / 10`: the party rank everywhere, and
   * `Prev` against an evil monster or `Prgd` against a good one. `stat all`
   * prints the sums as `AC vs Evil` and `vs Good`; absent or null adds none.
   */
  versusAll?: number | null;
  versusEvil?: number | null;
  versusGood?: number | null;
  /** `Player.Dodge`, in points (`prowess.dodge`). Absent or null dodges nothing. */
  dodge?: number | null;
}

/**
 * How a hazard that is not hit points is priced. `tuning.menace` — see
 * `TUNING_DEFAULTS` for what each is and why it sits where it does.
 */
export interface MenaceWeights {
  held: number;
  confused: number;
  blinded: number;
  slowed: number;
  afraid: number;
  summon: number;
  teleported: number;
  roomWide: number;
  lastingTicks: number;
  unitFloor: number;
  deathOverRounds: number;
}

/** What, beyond plain blows, a monster can do to the character. */
export type HazardKind =
  | 'damage'
  | 'drain'
  | 'poison'
  | 'held'
  | 'confused'
  | 'blinded'
  | 'slowed'
  | 'afraid'
  | 'summon'
  | 'teleported';

export interface Menace {
  /** Hit points a round beside this monster is expected to cost, hazards priced in. */
  perRound: number;
  /** Of `perRound`, the plain blows. */
  blows: number;
  /** Once, when it dies. Already amortised into `perRound`; kept for the readout. */
  onDeath: number;
  /** Its own health to work from — the high end, as `WorldMob.hp` is. */
  hp: number;
  /** `perRound / hp`: the figure the order is decided on. */
  weight: number;
  /** Every hazard the worst row brings, distinct, in a stable order. */
  hazards: HazardKind[];
  /** True when any of it reaches everybody in the room. */
  wide: boolean;
}

/*
 * The constants, from the server where MMUD Explorer agrees with it and from
 * MMUD Explorer's monster attack sim (`clsMonsterAttackSim`) where the two
 * compete, since todo 03 (2026-09-27) made MME the tiebreak: 1,000 energy a
 * round, at most six attempts at a swing a round (MME; the server's loop
 * allows fifty), effect ticks every 3 seconds and rounds every 5, magic
 * resistance clamped to 150 and pivoting at 50, and a `TypeOfResists` of 2
 * as a spell anybody can resist.
 */
export const ROUND_ENERGY = 1000;
export const MOB_ATTEMPTS = 6;
export const EFFECT_TICK_SECONDS = 3;
export const ROUND_SECONDS = 5;
const MAGIC_RES_CEILING = 150;
const MAGIC_RES_PIVOT = 50;
const RESISTED_BY_ANYONE = 2;
/** MME's `IsSpellResisted` clamps the resistance it halves at 196. */
const RESIST_ROLL_CEILING = 196;
/**
 * The realm's rows state armour class and damage resistance at ten times the
 * sheet's figure: an item's `ac: 10` is one point of armour class on `st`.
 */
export const REALM_ARMOUR_SCALE = 10;
/** MME's `GMUD_HIT_MIN` and `GMUD_HIT_CAP`: no blow is ever certain to miss. */
const HIT_FLOOR = 2;
const HIT_CEILING = 100;

/*
 * `Spells.Targets` as a *monster's* cast reads it — `Mob.InvokeBetweenRoundSpell`,
 * `TryInvokeSpell` and `ApplyDeathSpell` all switch on the same enum:
 * `Any` (6), `FullArea` (11) and `FullAttackArea` (12) reach every player in
 * the room; `Self` (1), `SelfOrUser` (2) and `FullPartyArea` (13) land on the
 * monster itself; everything else, the realm's own zero included (`User`),
 * lands on the monster's current target.
 */
const REACHES_THE_ROOM = new Set([6, 11, 12]);
const LANDS_ON_THE_CASTER = new Set([1, 2, 13]);

/** Whether a monster's cast of this spell lands on the monster itself. */
export function landsOnCaster(spell: WorldSpell): boolean {
  return LANDS_ON_THE_CASTER.has(spell.targets ?? 0);
}

/**
 * The chance a blow of this accuracy lands on a defender with this armour
 * class, as a fraction — `Mob.DoCombat`:
 *
 *     fixedDefense = (AC + secondary) / 10
 *     tempacc = 100 - (fixedDefense² / max((Acc² / 14) / 10, 1))
 *
 * in integer arithmetic throughout, then held between MME's 2% and 100%
 * (`GetHitMin`, `GetHitCap`), which it applies to both sides' blows. The
 * sheet's figure *is* `AC / 10`, so it goes in whole; the party-rank and
 * protection bonuses are taken as none. An unread armour class is taken as
 * none, which is the answer that makes every blow land.
 */
export function hitChance(accuracy: number, armourClass: number | null): number {
  const fixed = Math.max(0, Math.trunc(armourClass ?? 0));
  const reach = Math.max(Math.trunc(Math.trunc((accuracy * accuracy) / 14) / 10), 1);
  const percent = 100 - Math.trunc((fixed * fixed) / reach);
  return Math.min(HIT_CEILING, Math.max(HIT_FLOOR, percent)) / 100;
}

/**
 * Where a dodge percentage starts to taper and where it stops: MME's
 * `GMUD_DODGE_SOFTCAP` and `GMUD_DODGE_CAP`, which it moved from the server's
 * 45 on 2025-09-24.
 */
const DODGE_SOFT_POINT = 55;
const DODGE_CEILING = 98;
/** MME rolls no dodge against a blow of accuracy below this. */
const DODGE_LEAST_ACCURACY = 8;

/** `TGSGlobals.diminishing_returns` — a triangular-number taper, transcribed. */
function diminishingReturns(value: number, scale: number): number {
  if (value < 0) return -diminishingReturns(-value, scale);
  const mult = value / scale;
  return ((Math.sqrt(8 * mult + 1) - 1) / 2) * scale;
}

/**
 * How much of a swing a defender's dodge turns away, as a fraction —
 * `PlayerAttackType.GetDodgePercentAgainstDefense`, and `Mob.DoCombat`'s own
 * copy for a blow at a player, as MME's sim rolls it after the hit.
 *
 *     dodge% = dodge² / max((acc² / 14) / 10, 1)
 *
 * with the same denominator the hit roll uses, the excess above
 * `DODGE_SOFT_POINT` tapered through `diminishing_returns(excess, 4)`, held
 * under `DODGE_CEILING`, and nothing dodged below `DODGE_LEAST_ACCURACY`. A
 * defender whose dodge is not known dodges nothing, which is the answer that
 * makes the most swings land.
 */
export function dodgedFraction(dodgeValue: number | null, accuracyValue: number): number {
  const held = Math.max(0, Math.trunc(dodgeValue ?? 0));
  if (held === 0 || accuracyValue < DODGE_LEAST_ACCURACY) return 0;
  const reach = Math.max(Math.trunc(Math.trunc((accuracyValue * accuracyValue) / 14) / 10), 1);
  let percent = Math.trunc((held * held) / reach);
  if (percent > DODGE_SOFT_POINT) {
    percent = DODGE_SOFT_POINT + Math.trunc(diminishingReturns(percent - DODGE_SOFT_POINT, 4));
  }
  return Math.min(DODGE_CEILING, Math.max(0, percent)) / 100;
}

/**
 * Which side of `Mob.DoCombat`'s alignment test a monster is on:
 * `EvilPoints` is 100 for the four evil alignments and −75 for `Good` and
 * `LawfulGood`. Read back off what the realm file carries — a disposition
 * every row agrees on that only an evil alignment gives (`hostile`,
 * `hates-good`), or an attack that always costs evil points, which only a
 * good one does. Anything else is null, and null adds no protection.
 */
export function sideOf(mob: MenaceSubject): 'evil' | 'good' | null {
  if (mob.costly === 'always') return 'good';
  if (mob.uncertain === true) return null;
  if (mob.disposition === 'hostile' || mob.disposition === 'hates-good') return 'evil';
  return null;
}

/** The character as this monster's blows meet it: its armour with the protection that applies. */
export function facing(player: MenacePlayer, mob: MenaceSubject): MenacePlayer {
  if (player.armourClass === null) return player;
  const side = sideOf(mob);
  const ward =
    side === 'evil' ? (player.versusEvil ?? 0) : side === 'good' ? (player.versusGood ?? 0) : 0;
  return { ...player, armourClass: player.armourClass + (player.versusAll ?? 0) + ward };
}

/** The chance one blow of this accuracy does anything: the hit roll, less what dodge turns away. */
export function landsOn(accuracy: number, player: MenacePlayer): number {
  return (
    hitChance(accuracy, player.armourClass) * (1 - dodgedFraction(player.dodge ?? null, accuracy))
  );
}

/**
 * The protection the sheet does not print, as the server adds it
 * (`Mob.DoCombat`, `ActionFigure.GetPartyRankACBonus`): 5 in the middle rank
 * of a party and 10 at the back, and the `Prev` and `Prgd` sums of the effects
 * up — each buff's realm row, its stated figure or the low end of its power at
 * this level; a buff that could be several spells counts the least of them.
 * Items and the class row are not read, so this is a floor.
 */
export function protectionOf(
  state: Pick<CharacterState, 'buffs' | 'party' | 'name' | 'fullName'> & {
    progress: Pick<CharacterState['progress'], 'level'>;
  },
  spellOf: (name: string) => WorldSpell | null
): Pick<MenacePlayer, 'versusAll' | 'versusEvil' | 'versusGood'> {
  const level = state.progress.level ?? 0;
  const sum = (ability: number): number =>
    state.buffs.reduce((total, buff: ActiveBuff) => {
      const each = [buff.spell, ...(buff.candidates ?? [])].map((name) => {
        const spell = spellOf(name);
        const row = spell?.abilities?.find(([id]) => id === ability);
        if (spell === null || spell === undefined || row === undefined) return 0;
        return row[1] !== 0 ? row[1] : scaledPower(spell, level)[0];
      });
      return total + Math.max(0, Math.min(...each));
    }, 0);
  const members = state.party.members;
  const own =
    members.length > 1
      ? members.find((member) => member.name === state.name || member.name === state.fullName)
      : undefined;
  return {
    versusAll: own?.rank === 'mid' ? 5 : own?.rank === 'back' ? 10 : 0,
    versusEvil: sum(PROTECTION_ABILITY.evil),
    versusGood: sum(PROTECTION_ABILITY.good)
  };
}

/**
 * What a blow of `min`–`max` is expected to do through this damage
 * resistance, and how often it does anything at all.
 *
 * `damage = rand(min, max) - DR / 10`, and a blow that comes to nothing
 * neither prints nor applies its hit spell — so the mean is taken over the
 * blows that get through rather than over all of them minus the resistance,
 * which would understate a monster whose blows straddle the figure. The
 * sheet's figure is already `DR / 10`.
 */
export function expectedBlow(
  min: number,
  max: number,
  damageResist: number | null
): { damage: number; lands: number } {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const resist = Math.max(0, Math.trunc(damageResist ?? 0));
  const width = high - low + 1;
  const first = Math.max(low, resist + 1);
  if (first > high) return { damage: 0, lands: 0 };
  const count = high - first + 1;
  const total = (count * (first - resist + (high - resist))) / 2;
  return { damage: total / width, lands: count / width };
}

/**
 * A spell's power at a cast level — `Spell.RollAndApplySpellAbilities`:
 * the level is capped at `Cap`, and each end grows by `Inc` per `IncLVLs`
 * levels, truncated as the server truncates. A monster's cast at a stated
 * level is not capped (`caster: 'mob'`), as MME's `GetSpellMinDamage` reads
 * it for a monster.
 */
export function scaledPower(
  spell: WorldSpell,
  level: number,
  caster: 'player' | 'mob' = 'player'
): [number, number] {
  const uncapped = caster === 'mob' && level > 0;
  const capped =
    !uncapped && spell.cap !== undefined && spell.cap > 0 ? Math.min(level, spell.cap) : level;
  const [minBase, maxBase] = spell.power ?? [0, 0];
  const grow = (pair: [number, number] | undefined): number =>
    pair === undefined || pair[0] === 0 ? 0 : Math.trunc((capped / pair[0]) * pair[1]);
  return [minBase + grow(spell.minGrowth), maxBase + grow(spell.maxGrowth)];
}

/**
 * How much of a cast the target's magic resistance turns away, as MME's
 * `CalcResistedDamage` and `IsSpellResisted` read it where they differ from
 * `Spell.GetMagicResModifierVsTarget`.
 *
 * `factor` scales a resistable magnitude, the resistance clamped to 0–150:
 * `1 - (MR - 50) / 200` above the pivot and `1 - (MR - 50) / 100` below it, so
 * a target *below* 50 takes more than the spell states. `resist` is the chance
 * the whole cast is refused, `MR / 2` percent with the resistance clamped at
 * 196, rolled only for a spell the realm marks as resistable by anyone. A
 * spell carrying `NonMagicalSpell` (every bite and breath) is exempt from
 * both, as the server reads it. An unread resistance is taken as none, the
 * figure that lets the most through.
 */
export function magicResistance(
  spell: WorldSpell,
  magicRes: number | null
): { factor: number; resist: number } {
  const nonMagical = (spell.abilities ?? []).some(([id]) => id === HAZARD_ABILITY.nonMagical);
  if (nonMagical) return { factor: 1, resist: 0 };
  const read = Math.max(0, magicRes ?? 0);
  const held = Math.min(MAGIC_RES_CEILING, read);
  const factor = 1 - (held - MAGIC_RES_PIVOT) / (held >= MAGIC_RES_PIVOT ? 200 : 100);
  const resist =
    spell.resist === RESISTED_BY_ANYONE ? Math.min(RESIST_ROLL_CEILING, read) / 2 / 100 : 0;
  return { factor, resist };
}

/**
 * A spell's duration at a cast level, in three-second effect ticks: `Dur`
 * grown by `DurInc` per `DurIncLVLs` levels, uncapped for a monster's cast as
 * MME's `GetSpellDuration` reads it, capped at `Cap` for a player's.
 */
export function scaledDuration(
  spell: WorldSpell,
  level: number,
  caster: 'player' | 'mob' = 'player'
): number {
  const base = Math.max(0, spell.duration ?? 0);
  const growth = spell.durationGrowth;
  if (growth === undefined || growth[0] === 0 || level <= 0) return base;
  const capped =
    caster === 'player' && spell.cap !== undefined && spell.cap > 0
      ? Math.min(level, spell.cap)
      : level;
  return base + Math.trunc((capped / growth[0]) * growth[1]);
}

/** Rounds of a lasting effect: its ticks in five-second rounds, at least one. */
export function roundsOf(ticks: number): number {
  return Math.max(1, (ticks * EFFECT_TICK_SECONDS) / ROUND_SECONDS);
}

/** Whole rounds a monster's cast of this spell holds the character; 0 where it holds nothing. */
export function heldRoundsOf(spell: WorldSpell, level: number): number {
  if (landsOnCaster(spell)) return 0;
  const holds = (spell.abilities ?? []).some(([id]) => id === HAZARD_ABILITY.holdPerson);
  return holds ? Math.ceil(roundsOf(scaledDuration(spell, level, 'mob'))) : 0;
}

/**
 * What one application of a spell takes off the character's health, low and
 * high, magic resistance's thinning applied where the ability is the one it
 * thins (`damageWithMr`). Null where it lands on the caster or harms nothing.
 *
 * The damage, drain and poison abilities and a negative heal (`damnation`
 * states `Heal -2` over ten ticks) all wound; each states its own figure or
 * takes the spell's rolled power (`abil.Sum == 0 ? modifiedValue :
 * abil.Sum`), and several on one spell add. `menace` prices the mean and
 * `mobRound` rolls the range, so both read this.
 */
export interface Wound {
  low: number;
  high: number;
  kinds: Array<'damage' | 'drain' | 'poison'>;
}

export function woundOf(
  spell: WorldSpell,
  level: number,
  player: Pick<MenacePlayer, 'magicRes'>
): Wound | null {
  if (landsOnCaster(spell)) return null;
  const [powerLow, powerHigh] = scaledPower(spell, level, 'mob');
  const { factor } = magicResistance(spell, player.magicRes);
  let low = 0;
  let high = 0;
  const kinds = new Set<Wound['kinds'][number]>();
  const add = (kind: Wound['kinds'][number], value: number, scale: number): void => {
    const [a, b] = value !== 0 ? [Math.abs(value), Math.abs(value)] : [powerLow, powerHigh];
    if (Math.max(a, b) <= 0) return;
    low += Math.min(a, b) * scale;
    high += Math.max(a, b) * scale;
    kinds.add(kind);
  };
  for (const [id, value] of spell.abilities ?? []) {
    if (id === HAZARD_ABILITY.damage) add('damage', value, 1);
    else if (id === HAZARD_ABILITY.damageWithMr) add('damage', value, factor);
    else if (id === HAZARD_ABILITY.drain) add('drain', value, 1);
    else if (id === HAZARD_ABILITY.poison) add('poison', value, 1);
    else if (id === HAZARD_ABILITY.heal && value < 0) add('damage', value, 1);
  }
  return kinds.size === 0 ? null : { low, high, kinds: [...kinds] };
}

interface Hazard {
  harm: number;
  kinds: HazardKind[];
  wide: boolean;
}

const NOTHING: Hazard = { harm: 0, kinds: [], wide: false };

/**
 * What one cast of a spell is expected to cost, in hit points, with the
 * hazards that are not hit points priced in units of `unit`.
 *
 * `applications` is the cast plus every effect tick of the duration, because
 * that is how often the server calls `Hit` for a damage, drain or poison
 * ability — bounded by `lastingTicks`, since a poison that runs five minutes
 * is cured or outrun long before it runs out. A held, confused, blinded,
 * slowed or afraid character is priced per *round* of the duration, and the
 * two clocks differ: effect ticks are three seconds and rounds are five.
 * Confusion and fear state a percentage per action or tick and are scaled by
 * it; the rest are in force for as long as the effect holds.
 */
function hazardOf(
  spell: WorldSpell | undefined,
  level: number,
  unit: number,
  player: MenacePlayer,
  weights: MenaceWeights
): Hazard {
  if (spell === undefined) return NOTHING;
  const targets = spell.targets ?? 0;
  const wide = REACHES_THE_ROOM.has(targets);
  const onItself = landsOnCaster(spell);
  const [low, high] = scaledPower(spell, level, 'mob');
  const mean = (low + high) / 2;
  const ticks = scaledDuration(spell, level, 'mob');
  const rounds = roundsOf(ticks);
  const applications = 1 + Math.min(ticks, Math.max(0, weights.lastingTicks));
  const { resist } = magicResistance(spell, player.magicRes);
  // A percentage the ability states, else the spell's own power.
  const chance = (value: number): number =>
    Math.min(1, Math.max(0, (value !== 0 ? value : mean) / 100));

  let harm = 0;
  const kinds = new Set<HazardKind>();
  const add = (kind: HazardKind, amount: number): void => {
    if (amount <= 0) return;
    harm += amount;
    kinds.add(kind);
  };
  const wound = woundOf(spell, level, player);
  if (wound !== null) {
    harm += ((wound.low + wound.high) / 2) * applications;
    for (const kind of wound.kinds) kinds.add(kind);
  }
  for (const [id, value] of spell.abilities ?? []) {
    switch (id) {
      case HAZARD_ABILITY.holdPerson:
        if (!onItself) add('held', weights.held * unit * rounds);
        break;
      case HAZARD_ABILITY.confusion:
        if (!onItself) add('confused', weights.confused * unit * rounds * chance(value));
        break;
      case HAZARD_ABILITY.blind:
        if (!onItself) add('blinded', weights.blinded * unit * rounds);
        break;
      case HAZARD_ABILITY.slowness:
        if (!onItself) add('slowed', weights.slowed * unit * rounds);
        break;
      case HAZARD_ABILITY.fear:
        if (!onItself) add('afraid', weights.afraid * unit * rounds * chance(value));
        break;
      case HAZARD_ABILITY.summon:
        // Whoever the spell names, the ally arrives in this room.
        add('summon', weights.summon * unit);
        break;
      case HAZARD_ABILITY.teleportRoom:
        if (!onItself) add('teleported', weights.teleported * unit);
        break;
      default:
        break;
    }
  }
  if (harm <= 0) return NOTHING;
  harm *= 1 - resist;
  if (wide) harm *= weights.roomWide;
  return { harm, kinds: [...kinds], wide };
}

/** A condition a monster can put on the character, beyond wounds. */
export type AfflictionKind = 'poison' | 'blinded' | 'held';

export interface MobAffliction {
  kind: AfflictionKind;
  /**
   * Seconds the longest such spell holds — `Spells.Dur` in three-second
   * effect ticks — or null where any spell of the kind states no duration,
   * because a poison of unknown length is not shortened by another whose
   * length is known.
   */
  seconds: number | null;
}

/**
 * What a monster can put on the character, read off every spell it brings:
 * the hit spells on its blows, the casts in place of a blow, the between-round
 * casts and the one it dies with — any row, not the worst, since a hunting
 * estimate is about every visit and not one fight. A spell that lands on the
 * caster is not an affliction. Duration as `hazardOf` reads it.
 */
export function afflictionsOf(mob: MenaceSubject): MobAffliction[] {
  const spells = mob.spells ?? {};
  const longest = new Map<AfflictionKind, number | null>();
  const note = (id: number | undefined): void => {
    if (id === undefined) return;
    const spell = spells[id];
    if (spell === undefined || landsOnCaster(spell)) return;
    const ticks = spell.duration ?? 0;
    const seconds = ticks > 0 ? ticks * EFFECT_TICK_SECONDS : null;
    for (const [ability] of spell.abilities ?? []) {
      const kind: AfflictionKind | null =
        ability === HAZARD_ABILITY.poison
          ? 'poison'
          : ability === HAZARD_ABILITY.blind
            ? 'blinded'
            : ability === HAZARD_ABILITY.holdPerson
              ? 'held'
              : null;
      if (kind === null) continue;
      const known = longest.get(kind);
      if (known === undefined) longest.set(kind, seconds);
      else if (known === null || seconds === null) longest.set(kind, null);
      else longest.set(kind, Math.max(known, seconds));
    }
  };
  for (const profile of mob.profiles ?? []) {
    for (const attack of profile.attacks)
      note(attack.kind === 'melee' ? attack.onHit : attack.spell);
    for (const cast of profile.casts) note(cast.spell);
  }
  note(mob.deathSpell);
  return [...longest].map(([kind, seconds]) => ({ kind, seconds }));
}

/**
 * How many blows a round holds, in expectation — `Mob.DoCombat` grants 1,000
 * energy a round and swings until it is spent, at most `MOB_ATTEMPTS` times,
 * so the count is the grant over the energy an average swing costs. A profile
 * whose swings cost nothing swings every attempt. `mobRound.ts` rolls the
 * same round swing by swing.
 */
export function mobSwingsPerRound(
  attacks: ReadonlyArray<Pick<MobAttack, 'chance' | 'energy'>>
): number {
  const perSwing = attacks.reduce((sum, attack) => sum + attack.chance * attack.energy, 0);
  if (perSwing <= 0) return attacks.length > 0 ? MOB_ATTEMPTS : 0;
  return Math.min(MOB_ATTEMPTS, ROUND_ENERGY / perSwing);
}

/** Plain blows only: what the room's `unit` is made from. */
function bloodPerRound(profile: MobProfile, player: MenacePlayer): number {
  const swings = mobSwingsPerRound(profile.attacks);
  let perSwing = 0;
  for (const attack of profile.attacks) {
    if (attack.kind !== 'melee') continue;
    const { damage } = expectedBlow(attack.min, attack.max, player.damageResist);
    perSwing += attack.chance * landsOn(attack.accuracy, player) * damage;
  }
  return swings * perSwing;
}

/** One row's whole cost per round, hazards priced in. */
function rowPerRound(
  profile: MobProfile,
  spells: Record<number, WorldSpell>,
  unit: number,
  player: MenacePlayer,
  weights: MenaceWeights
): { perRound: number; blows: number; kinds: Set<HazardKind>; wide: boolean } {
  const kinds = new Set<HazardKind>();
  let wide = false;
  const take = (hazard: Hazard, scale: number): number => {
    if (hazard.harm <= 0 || scale <= 0) return 0;
    for (const kind of hazard.kinds) kinds.add(kind);
    wide = wide || hazard.wide;
    return hazard.harm * scale;
  };

  const swings = mobSwingsPerRound(profile.attacks);
  let blows = 0;
  let perSwing = 0;
  for (const attack of profile.attacks) {
    if (attack.kind === 'melee') {
      const hit = landsOn(attack.accuracy, player);
      const { damage, lands } = expectedBlow(attack.min, attack.max, player.damageResist);
      blows += attack.chance * hit * damage;
      // The hit spell rides on a blow that did damage, at level zero —
      // `spell.ApplyMobCastSpell(this, tempTargets, 0, true)`.
      if (attack.onHit !== undefined) {
        perSwing += take(
          hazardOf(spells[attack.onHit], 0, unit, player, weights),
          attack.chance * hit * lands
        );
      }
    } else {
      perSwing += take(
        hazardOf(spells[attack.spell], attack.level, unit, player, weights),
        attack.chance * attack.castChance
      );
    }
  }
  let perRound = swings * (blows + perSwing);
  blows *= swings;
  for (const cast of profile.casts) {
    perRound += take(hazardOf(spells[cast.spell], cast.level, unit, player, weights), cast.chance);
  }
  return { perRound, blows, kinds, wide };
}

/**
 * Every monster in a room, weighed against this character.
 *
 * Returned in the order given, one answer per monster. `null` is **the realm
 * does not say** — a monster it cannot place, or a realm file converted
 * before profiles were written — and never *harmless*: `rankByMenace` puts
 * those first, because the reassuring guess is the dangerous one. A monster
 * the realm knows and states no attack for weighs nothing, which is a
 * different fact.
 *
 * The room is weighed together because the unit a hazard is priced in is the
 * room's: a round held next to three ogres is not a round held next to a rat.
 */
export function weighRoom(
  mobs: readonly MenaceSubject[],
  player: MenacePlayer,
  weights: MenaceWeights
): Array<Menace | null> {
  const blood = mobs.map((mob) =>
    mob.profiles === undefined
      ? 0
      : mob.profiles.reduce(
          (worst, row) => Math.max(worst, bloodPerRound(row, facing(player, mob))),
          0
        )
  );
  const unit = Math.max(
    Math.max(0, weights.unitFloor),
    blood.reduce((sum, each) => sum + each, 0)
  );
  const rounds = Math.max(1, weights.deathOverRounds);

  return mobs.map((mob) => {
    if (mob.profiles === undefined) return null;
    const spells = mob.spells ?? {};
    let worst = { perRound: 0, blows: 0, kinds: new Set<HazardKind>(), wide: false };
    const against = facing(player, mob);
    for (const row of mob.profiles) {
      const weighed = rowPerRound(row, spells, unit, against, weights);
      if (weighed.perRound > worst.perRound) worst = weighed;
    }
    const death =
      mob.deathSpell === undefined
        ? NOTHING
        : hazardOf(spells[mob.deathSpell], 0, unit, player, weights);
    for (const kind of death.kinds) worst.kinds.add(kind);
    // Once, whenever it dies — and best taken early, at full health, which
    // is why it counts towards the order at all rather than being a fixed
    // cost of the fight. Spread over the rounds a kill is taken to need.
    const perRound = worst.perRound + death.harm / rounds;
    const hp = mob.hp !== undefined && mob.hp > 0 ? mob.hp : 1;
    return {
      perRound,
      blows: worst.blows,
      onDeath: death.harm,
      hp,
      weight: perRound / hp,
      hazards: [...worst.kinds],
      wide: worst.wide || death.wide
    };
  });
}

/**
 * The order to take a room's monsters in: the ones the realm cannot weigh
 * first, then by weight, ties in the order given.
 *
 * Indices rather than entities, so a caller ranking a filtered list can map
 * back to whatever it filtered from.
 */
export function rankByMenace(menaces: ReadonlyArray<Menace | null>): number[] {
  return menaces
    .map((menace, index) => ({ menace, index }))
    .sort((a, b) => {
      if (a.menace === null || b.menace === null) {
        if (a.menace === null && b.menace === null) return a.index - b.index;
        return a.menace === null ? -1 : 1;
      }
      return b.menace.weight - a.menace.weight || a.index - b.index;
    })
    .map((entry) => entry.index);
}
