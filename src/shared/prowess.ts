import type { BlessingEffect } from './blessingeffects';
import { dodgedFraction, hitChance } from './menace';
import type { RealmFamily } from './realm';
import type { StatedProwess } from './stated';
import type { WorldItem, WorldSpell } from './world';

/**
 * What this character does back — the other half of `menace.ts`.
 *
 * `menace.ts` models what a monster costs a character and says in its own
 * header that *the character's own damage output is not known to the client at
 * all*. This is that half: accuracy, dodge, swings, a blow, a cast's odds and
 * what regeneration returns. Same shape, same rules — pure, dependency-free,
 * transcribed from the server's own source with the routine named beside each
 * formula.
 *
 * ## Two things are new here, and both matter more than the formulas
 *
 * **Every answer carries where it came from.** A number a player will act on
 * has to say whether the server stated it, whether this client computed it
 * from the server's source, or whether it is a bound rather than an estimate.
 * That is the null-is-not-zero rule applied to arithmetic: an answer with no
 * provenance is indistinguishable from a guess, and this client's whole
 * position is that it does not guess. See `Provenance`.
 *
 * **The family is a parameter, never an ambient global.** Two lineages ship
 * and they disagree on nearly every formula here
 * (docs/mudplay/03-the-realms-formula-family.md). This client runs several
 * characters in one process, so a module-level "current realm" is not untidy,
 * it is a defect waiting for a second tab: a Paradigm character and a
 * GreaterMUD character in adjacent tabs would contaminate each other. Every
 * function takes the family and **answers `null` for a family whose formula is
 * not known**, which today means everything below answers `null` on the
 * MajorMUD lineage. That asymmetry is correct and deliberate: GreaterMUD has
 * the server's own source on this machine and the MajorMUD lineage has
 * captures and the fight log and no source at all. Falling back to the other
 * family's arithmetic would produce a number, and a wrong one, silently.
 *
 * ## What the server states, and why that outranks all of this
 *
 * `stat all` prints accuracy, swings per round, damage range, dodge and both
 * regeneration figures **as the server computes them**
 * (docs/greatermud/player-and-world.md), gear and spells included. Read since
 * 2026-09-18 (`user-stat-all`, `src/shared/stated.ts`), and handed in as
 * `ProwessSheet.stated` only while what it was computed from still holds: the
 * sheet's figure wins wherever it is present, needing no family because
 * nothing was computed, and the formulas answer the rest — and every *what if
 * I wore this* — as they always did.
 */

/**
 * Where a number came from, strongest first.
 *
 * The existing rule — *patterns come from captures; where a capture and the
 * source disagree, the wire wins* — applied to arithmetic instead of to
 * regexes. It is what stops a source-derived formula quietly outranking a
 * measurement.
 */
export type Provenance =
  /** The server said it: a printed figure, read off the wire. */
  | 'stated'
  /** The server's own code says it. GreaterMUD only; there is no MajorMUD source. */
  | 'source'
  /** The fight log says it, with a count behind it. */
  | 'measured'
  /** A limit rather than an estimate — an upper or lower bound, and labelled as one. */
  | 'bound';

export const PROVENANCES: readonly Provenance[] = ['stated', 'source', 'measured', 'bound'];

/**
 * A number with its provenance, or nothing at all.
 *
 * `null` is the fourth answer and it is a real one: *not knowable*, rendered as
 * unknown and never as a figure. There is no zero-with-a-shrug in this module.
 */
export interface Reckoning<T> {
  value: T;
  from: Provenance;
}

/** The sheet figures the arithmetic reads. Null everywhere is *not read yet*. */
export interface ProwessSheet {
  level: number | null;
  agility: number | null;
  intellect: number | null;
  charm: number | null;
  willpower: number | null;
  health: number | null;
  strength: number | null;
  spellcasting: number | null;
  /** `Classes.CombatLVL`, off the realm's class row. The realm knows it; the sheet does not print it. */
  combatLevel: number | null;
  /** `Classes.MageryLVL`, 1–3. Null for a class that casts nothing. */
  mageryLevel: number | null;
  /**
   * How full the pack is, 0–100.
   *
   * The server reads *below 33%* as the threshold for two separate bonuses, so
   * this is the one input where absence changes an answer rather than removing
   * it. Unread is taken as **at or above** the threshold — the bonus is not
   * granted — because unknown is never the reassuring answer.
   */
  encumbrancePercent: number | null;
  /**
   * What the last `stat all` said that still holds (`statedNow`), which
   * outranks every formula here. Absent or null is *not stated*.
   */
  stated?: StatedProwess | null;
  /**
   * Blessings up, and the martial rows of what is worn (`gearEffect`),
   * counted on the formula paths only (`blessingeffects.ts`): a figure
   * `stat all` stated already carries what was up, and it states no punch or
   * kick. Absent or null is none.
   */
  effects?: BlessingEffect | null;
}

/** What of a class the sheet cannot state. See `ProwessSheet.combatLevel`. */
export interface ProwessClass {
  combat?: number;
  magery?: number;
}

/** What of a weapon the arithmetic reads — `Items.Min/Max/Accy/Speed/StrReq`. */
export type ProwessWeapon = NonNullable<WorldItem['weapon']>;

/** Percentage of `MaxEnc` below which the server grants its two carry bonuses. */
const LIGHT_LOAD = 33;

/**
 * A cast can be no more likely than certain — `GMUDServer.MAX_SUCCESS_RATE`.
 * The same constant caps a miss percentage, which is why it is named for the
 * roll and not for the spell.
 */
const MAX_SUCCESS_RATE = 100;

/** `TimedEventManager.RegenTickTime`, in seconds. */
export const REGEN_TICK_SECONDS = 121;

/** Every input present, or nothing computed. There is no default stat here. */
function need(...values: Array<number | null>): number[] | null {
  const held: number[] = [];
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) return null;
    held.push(value);
  }
  return held;
}

/**
 * The character's own accuracy — `Player.CalcAccuracy`, `Player.cs:4178`.
 *
 *     acc  = the sum of Accuracy abilities, or 1 when there are none
 *     acc += 15 - enc% / 10                     only while enc% < 33
 *     acc += ((floor(sqrt(level)) * (combat - 1)) + ((combat * 2) + level / 2) - 2) * 2
 *     acc += (AGI - 50) / 3 + (INT - 50) / 6 + (CHM - 50) / 10
 *     acc -= 15                                 when the weapon's StrReq exceeds STR
 *
 * Integer arithmetic throughout, and the truncation is the server's: C# integer
 * division truncates toward zero, which for a stat below 50 rounds *up* toward
 * it. `Math.trunc` is that, and `Math.floor` would not be.
 *
 * The party-rank term (+10 front, −5 mid, −10 back) is deliberately left out:
 * this client does not read its own rank off any surface, and inventing one
 * would move every downstream figure by a tenth. A character in a party is
 * therefore quoted its solo accuracy, which is the front-rank case minus ten.
 *
 * Accuracy abilities are gear and spells the client cannot enumerate, so the
 * base is the server's own `1` — the value it uses when a character has none.
 * That makes this a **lower bound** for a character wearing anything that
 * grants accuracy, which is why it is labelled `bound` rather than `source`
 * whenever a weapon is in hand: a bound that under-promises is the safe
 * direction for a number that decides whether to start a fight.
 */
export function accuracy(
  sheet: ProwessSheet,
  weapon: ProwessWeapon | null,
  family: RealmFamily | null
): Reckoning<number> | null {
  const said = sheet.stated?.accuracy;
  if (said !== undefined) return { value: said, from: 'stated' };
  if (family !== 'greatermud') return null;
  const held = need(sheet.level, sheet.agility, sheet.intellect, sheet.charm, sheet.combatLevel);
  if (held === null) return null;
  const [level, agility, intellect, charm, combat] = held as [
    number,
    number,
    number,
    number,
    number
  ];

  // The `Accuracy` rows' sum, or 1 where they sum to nothing.
  const blessed = sheet.effects?.accuracy ?? 0;
  let acc = blessed !== 0 ? blessed : 1;
  const enc = sheet.encumbrancePercent;
  if (enc !== null && enc < LIGHT_LOAD) acc += Math.trunc(15 - enc / 10);
  const levelValue = Math.floor(Math.sqrt(level));
  acc += (levelValue * (combat - 1) + (combat * 2 + Math.trunc(level / 2) - 2)) * 2;
  acc +=
    Math.trunc((agility - 50) / 3) +
    Math.trunc((intellect - 50) / 6) +
    Math.trunc((charm - 50) / 10);
  /*
   * `IsWeaponHeavy` — the weapon asks for more strength than the character
   * has. Only chargeable when both halves are known: a weapon whose `StrReq`
   * the realm does not carry, or a character whose strength no sheet has
   * stated, must not be penalised on an absence.
   */
  const heavy =
    weapon?.strength !== undefined && sheet.strength !== null && weapon.strength > sheet.strength;
  if (heavy) acc -= 15;

  /*
   * `source` only when every term is in hand. A weapon may grant accuracy the
   * client cannot enumerate, and an **unread pack** withholds the light-load
   * bonus above rather than granting it — so either makes this a floor, and a
   * floor is a `bound`. Measured 2026-09-05 (`npm run probe:statall`): with the
   * pack unread the client said 30 where the server printed 45, and the 15 it
   * was short was exactly the bonus it had rightly withheld.
   */
  return {
    value: Math.max(1, acc),
    from: weapon === null && enc !== null ? 'source' : 'bound'
  };
}

/**
 * The character's own dodge — `Player.Dodge`, `Player.cs:4405`.
 *
 *     dodge  = (CHM - 50) / 5 + level / 5 + (AGI - 50) / 3
 *     dodge += 10 - enc% / 10                   only while enc% < 33
 *
 * §3 of the roadmap called dodge unknowable and it is not: every input is on
 * the ordinary stat sheet the client already reads. What is not on any sheet is
 * the *ability* term — gear and spells that grant dodge — so this is a floor,
 * and a floor is what a `bound` is.
 */
export function dodge(sheet: ProwessSheet, family: RealmFamily | null): Reckoning<number> | null {
  if (family !== 'greatermud') return null;
  const held = need(sheet.charm, sheet.level, sheet.agility);
  if (held === null) return null;
  const [charm, level, agility] = held as [number, number, number];

  let value = Math.trunc((charm - 50) / 5) + Math.trunc(level / 5) + Math.trunc((agility - 50) / 3);
  const enc = sheet.encumbrancePercent;
  if (enc !== null && enc < LIGHT_LOAD) value += Math.trunc(10 - enc / 10);
  value += sheet.effects?.dodge ?? 0;
  return { value: Math.max(0, value), from: 'bound' };
}

/**
 * How many blows a round buys — `PlayerAttackType.Swings`, which is
 * `CalcEnergyUsedWithEncum` (`Player.cs:5520`) against the 1,000 energy a
 * round grants, **rounded to three decimals and never floored**:
 *
 *     energy  = Speed * 1000 div ((((level * CombatLVL) + 45) * (AGI + 150)) * 1500 div 9000)
 *     energy  = ((StrReq - STR) * 3 + 200) * energy div 200      only while STR < StrReq
 *     energy  = energy * (enc% div 2 + 75) div 100
 *     swings  = round(1000 / energy, 3)
 *
 * Integer division throughout, in the server's order. Three things a first
 * transcription got wrong and the wire corrected (`npm run probe:statall`,
 * 2026-09-05, the first `stat all` this client ever captured):
 *
 * - **The combat term is `level × CombatLVL`**, not `level × (CombatLVL + 2)`.
 *   `CalcEnergyUsed` does add two — and its only caller hands it
 *   `CharClass.CombatLevel − 2` (`PlayerAttackType.cs:512`), so the two cancel.
 *   The notes in docs/greatermud/player-and-world.md recorded the routine and
 *   not its caller.
 * - **Swings are a fraction.** The sheet printed `1.842` for the attack and
 *   `0.921` for the bash, and the server's own average-per-round multiplies by
 *   that fraction (`dmg * Swings`, capped at `Misc.maxSwings`, six). A whole
 *   number here understated a 1.842-swing character by nearly half and
 *   carried `source` while doing it; the floor of one was wrong in the other
 *   direction, for a bash that swings less than once a round.
 * - **An unread pack is taken as full**, the fewest swings, so the answer is
 *   then a floor and says so.
 */
export function swingsPerRound(
  sheet: ProwessSheet,
  weapon: ProwessWeapon | null,
  family: RealmFamily | null
): Reckoning<number> | null {
  // Unarmed too: the sheet prints the bare-handed round, which no formula here has.
  const said = sheet.stated?.swings;
  if (said !== undefined) return { value: said, from: 'stated' };
  const energy = energyPerSwing(sheet, weapon, family);
  if (energy === null) return null;
  return { value: swingsFor(energy.value), from: energy.from };
}

/** Blows a round of 1,000 energy buys, rounded to three decimals as the sheet prints them. */
function swingsFor(energy: number): number {
  return Math.round((1000 / energy) * 1000) / 1000;
}

/** `CalcEnergyUsedWithEncum`, the body of `swingsPerRound` above. */
function energyPerSwing(
  sheet: ProwessSheet,
  weapon: ProwessWeapon | null,
  family: RealmFamily | null
): Reckoning<number> | null {
  if (family !== 'greatermud') return null;
  const speed = weapon?.speed;
  if (speed === undefined || speed <= 0) return null;
  const held = need(sheet.level, sheet.agility, sheet.combatLevel);
  if (held === null) return null;
  const [level, agility, combat] = held as [number, number, number];

  const divisor = Math.trunc(((level * combat + 45) * (agility + 150) * 1500) / 9000);
  if (divisor <= 0) return null;
  let energy = Math.trunc((speed * 1000) / divisor);
  const strReq = weapon?.strength;
  if (strReq !== undefined && sheet.strength !== null && sheet.strength < strReq) {
    energy = Math.trunc((((strReq - sheet.strength) * 3 + 200) * energy) / 200);
  }
  const enc = sheet.encumbrancePercent;
  const encum = Math.trunc(enc ?? 100);
  energy = Math.trunc((energy * (Math.trunc(encum / 2) + 75)) / 100);
  if (energy <= 0) return null;
  return { value: energy, from: enc === null ? 'bound' : 'source' };
}

/**
 * The most blows the server will let a round land — `Misc.maxSwings`. The
 * sheet prints the uncapped figure; the damage loop and the sheet's own
 * average use `Swings > 6 ? 6 : Swings` (`PlayerAttackType.cs:654`).
 */
export const MAX_SWINGS = 6;

/**
 * The three ways of swinging a weapon, by the server's `CombatRound` classes.
 * A punch or a kick swings no weapon, and a backstab is one blow, not a round.
 */
export const SWING_METHODS = ['attack', 'bash', 'smash'] as const;

export type SwingMethod = (typeof SWING_METHODS)[number];

/**
 * What each method does to the round (`AttackTypes/*CombatRound.cs`): the
 * pre-roll multiplier on the weapon's range, the damage multiplier rolled
 * between its two ends, and the energy one blow costs. A bash is two blows'
 * energy at 2.5–3× a 1.1× range; a smash spends the whole round on one blow at
 * 5× a 1.2× range.
 */
const METHOD: Readonly<
  Record<SwingMethod, { preRoll: number; multiplier: number; energy(perSwing: number): number }>
> = {
  attack: { preRoll: 1, multiplier: 1, energy: (perSwing) => perSwing },
  bash: { preRoll: 1.1, multiplier: 2.75, energy: (perSwing) => perSwing * 2 },
  smash: { preRoll: 1.2, multiplier: 5, energy: () => 1000 }
};

/**
 * What a weapon does in a round swung this way, before the target's armour,
 * its dodge and a miss: blows a round (capped at `MAX_SWINGS`) times the mean
 * blow. The figure a slot's quick view ranks weapons by.
 *
 * A candidate weapon is not the one in hand, so what `stat all` said about the
 * round is not read here. Always a `bound`: the character's own damage bonus
 * and a critical are not counted, and neither changes which weapon is better.
 */
export function roundDamage(
  sheet: ProwessSheet,
  weapon: ProwessWeapon,
  method: SwingMethod,
  family: RealmFamily | null
): Reckoning<number> | null {
  return roundOf(blowOf(sheet, weapon, { kind: method, bonus: 0 }, family));
}

/**
 * The three martial-arts attacks, by the server's `CombatRound` classes. None
 * swings a weapon: the range comes from the character's level.
 */
export const MARTIAL_ATTACKS = ['punch', 'kick', 'jumpkick'] as const;

export type MartialAttack = (typeof MARTIAL_ATTACKS)[number];

/**
 * `AttackTypes/{Punch,Kick,Jumpkick}CombatRound.cs`: the range below level 20
 * and from 20 on, the round's speed in the server's weapon units, and the
 * damage multiplier (the same at both ends, so rolled as one figure).
 */
const MARTIAL: Readonly<
  Record<
    MartialAttack,
    {
      low(level: number): number;
      high(level: number): number;
      speed: number;
      multiplier: number;
    }
  >
> = {
  punch: {
    low: (level) => (level < 20 ? Math.trunc(level / 8) + 2 : Math.max(5, Math.trunc(level / 6))),
    high: (level) =>
      level < 20 ? Math.trunc((level + 3) / 4) + 6 : Math.max(12, Math.trunc(level / 4)),
    speed: 1150,
    multiplier: 1
  },
  kick: {
    low: (level) => (level < 20 ? Math.trunc(level / 8) + 2 : Math.max(5, Math.trunc(level / 6))),
    high: (level) => (level < 20 ? Math.trunc(level / 5) + 7 : Math.max(10, Math.trunc(level / 4))),
    speed: 1400,
    multiplier: 1.33
  },
  jumpkick: {
    low: (level) => (level < 20 ? Math.trunc(level / 8) + 2 : Math.max(5, Math.trunc(level / 6))),
    high: (level) => (level < 20 ? Math.trunc(level / 6) + 7 : Math.max(10, Math.trunc(level / 4))),
    // `GreaterMUD.Module`'s `JumpkickCombatRound.Speed`: 2900 ("was 1900, then 3000").
    speed: 2900,
    multiplier: 1.66
  }
};

/**
 * What a martial-arts round does, before the target's armour, its dodge and a
 * miss: the level's range plus the attack's own damage ability
 * (`PunchDmg`/`KickDmg`/`JumpKDmg`, summed off the class and race rows by the
 * caller) and strength's bonus, times the blows the round's speed buys and
 * the multiplier. A `bound`, as `roundDamage` is.
 */
export function martialRoundDamage(
  sheet: ProwessSheet,
  attack: MartialAttack,
  bonus: number,
  family: RealmFamily | null
): Reckoning<number> | null {
  return roundOf(blowOf(sheet, null, { kind: attack, bonus }, family));
}

/** Every attack a character can make: a weapon swung one of three ways, or a martial one. */
export type AttackKind = SwingMethod | MartialAttack;

/**
 * The attack a fight is fought with (`combat.attack`), and a martial attack's
 * own damage ability (`PunchDmg`/`KickDmg`/`JumpKDmg`), summed by the caller.
 */
export interface ProwessAttack {
  kind: AttackKind;
  bonus: number;
}

/** `a`: the weapon in hand, or the bare hand, swung plainly. */
export const PLAIN_ATTACK: ProwessAttack = { kind: 'attack', bonus: 0 };

/**
 * The bare hand's range and speed (`PlayerAttackType.Min`/`Max`/`Speed` with
 * no weapon equipped): 1–3 at 1200.
 */
export const BARE_HAND: ProwessWeapon = { min: 1, max: 3, speed: 1200 };

/** Whether an attack is one of the three martial ones, which swing no weapon. */
export function isMartial(kind: AttackKind): kind is MartialAttack {
  return (MARTIAL_ATTACKS as readonly string[]).includes(kind);
}

/** One blow of an attack: its range after the pre-roll, its multiplier, and the blows a round buys. */
interface Blow {
  low: number;
  high: number;
  multiplier: number;
  blows: number;
  from: Provenance;
}

/**
 * What a blow of this attack is, from the weapon in hand (the bare hand
 * without one) or, for a martial attack, the level's own range.
 */
function blowOf(
  sheet: ProwessSheet,
  weapon: ProwessWeapon | null,
  attack: ProwessAttack,
  family: RealmFamily | null
): Blow | null {
  const strong = strengthBonus(sheet.strength, sheet.effects?.maxDamage ?? 0);
  if (isMartial(attack.kind)) {
    const level = sheet.level;
    if (level === null) return null;
    const how = MARTIAL[attack.kind];
    const bonus = attack.bonus + (sheet.effects?.martialDamage[attack.kind] ?? 0);
    const low = how.low(level) + bonus + strong.low;
    const high = how.high(level) + bonus + strong.high;
    const perSwing = energyPerSwing(sheet, { min: low, max: high, speed: how.speed }, family);
    if (perSwing === null || high < low) return null;
    const blows = Math.min(MAX_SWINGS, swingsFor(perSwing.value));
    return { low, high, multiplier: how.multiplier, blows, from: perSwing.from };
  }
  const held = weapon ?? BARE_HAND;
  const perSwing = energyPerSwing(sheet, held, family);
  if (perSwing === null || held.max < held.min) return null;
  const how = METHOD[attack.kind];
  return {
    low: Math.floor((held.min + strong.low) * how.preRoll),
    high: Math.floor((held.max + strong.high) * how.preRoll),
    multiplier: how.multiplier,
    blows: Math.min(MAX_SWINGS, swingsFor(how.energy(perSwing.value))),
    from: perSwing.from
  };
}

/**
 * `Player.MinDamage` and `MaxDamage`: strength's bonus to the low end above
 * 100 and to the high end above 50, a point each ten, on every attack, and
 * the `MaxDamage` rows of what is blessed (`ProwessSheet.effects`). An unread
 * strength adds nothing, and the `MaxDamage` gear may add is not seen, so a
 * figure carrying it is a floor.
 */
function strengthBonus(strength: number | null, maxDamage: number): { low: number; high: number } {
  if (strength === null) return { low: 0, high: maxDamage };
  return {
    low: Math.max(0, Math.trunc((strength - 100) / 10)),
    high: Math.max(0, Math.trunc((strength - 50) / 10)) + maxDamage
  };
}

/**
 * What each attack adds to the accuracy it rolls with
 * (`PlayerAttackType.AttackTypeAccMod`, overridden per `CombatRound`).
 */
const ACCURACY_MOD: Readonly<Record<AttackKind, number>> = {
  attack: 0,
  bash: -15,
  smash: -25,
  punch: 0,
  kick: -10,
  jumpkick: -15
};

/** The attacks a blow of which can be critical (`PlayerAttackType.CrittableAttacks`). */
const CRITTABLE: ReadonlySet<AttackKind> = new Set(['attack', 'punch', 'kick', 'jumpkick']);

/** `GMUDServer.CRIT_MAX`: no attack crits more often than this, in per cent. */
const CRIT_MAX = 65;

/**
 * The chance a landed blow is critical, 0–0.65 (`PlayerAttackType.GetCrits`):
 * `Player.CritsFromStats` (a point per ten levels, per ten intellect over 50,
 * per twenty agility over 50 and per thirty charm over 50, at least 1), and
 * seven less the class's combat level for a class that fights poorly. None
 * for a bash or a smash. A `bound`: the crits gear and spells add and the
 * quick-and-deadly bonus are not seen.
 */
export function critChance(
  sheet: ProwessSheet,
  attack: AttackKind,
  family: RealmFamily | null
): Reckoning<number> | null {
  if (family !== 'greatermud') return null;
  if (!CRITTABLE.has(attack)) return { value: 0, from: 'source' };
  const held = need(sheet.level, sheet.intellect, sheet.agility, sheet.charm, sheet.combatLevel);
  if (held === null) return null;
  const [level, intellect, agility, charm, combat] = held as [
    number,
    number,
    number,
    number,
    number
  ];
  const fromStats = Math.max(
    1,
    Math.trunc(level / 10) +
      Math.trunc((intellect - 50) / 10) +
      Math.trunc((agility - 50) / 20) +
      Math.trunc((charm - 50) / 30)
  );
  const crits = fromStats + (sheet.effects?.crits ?? 0) + Math.max(0, 7 - combat);
  return { value: Math.min(CRIT_MAX, Math.max(0, crits)) / 100, from: 'bound' };
}

/**
 * A round of blows before the target's armour, dodge and a miss. A `bound`:
 * a critical is left out, the same for every attack, so two attacks compare
 * like with like.
 */
function roundOf(blow: Blow | null): Reckoning<number> | null {
  if (blow === null) return null;
  return { value: (blow.blows * (blow.low + blow.high) * blow.multiplier) / 2, from: 'bound' };
}

/** What a swing is expected to do to one target, and how long the target lasts. */
export interface Swing {
  /** Chance one blow lands, 0–1: the hit roll less what dodge turns away. */
  lands: Reckoning<number>;
  /** Mean damage of a blow that lands, a critical's share counted, after the target's damage resistance. */
  damage: Reckoning<number>;
  /** Blows a round buys, from `swingsPerRound`. Null when the round cannot be worked out. */
  swings: Reckoning<number> | null;
  /** The chance a landed blow is critical, already in `damage` (`critChance`). */
  crit: Reckoning<number> | null;
  /** A blow's range before the target's resistance, the multiplier applied; null where unknown. */
  range: { low: number; high: number } | null;
  /**
   * Rounds to take the target's health down, or `null` when the target's
   * health is not known or nothing gets through its resistance.
   *
   * A **bound**, always, and in the honest direction: accuracy here is a floor
   * (gear grants the client cannot see), dodge is a floor, and neither critical
   * hits nor a hit spell is counted. So the true figure is *at most* this.
   */
  rounds: Reckoning<number> | null;
}

/** What of a target the swing reads. `menace.ts` reads the mirror of it. */
export interface ProwessTarget {
  /** `Monsters.ArmourClass`, already divided down the way the sheet prints it. */
  armourClass: number | null;
  /** `Monsters.DamageResist`, likewise. */
  damageResist: number | null;
  /** The monster's own dodge — its `Abil-n = 34` slot. Null dodges nothing. */
  dodge: number | null;
  /** Its maximum health, where the realm or the lore can name one. */
  health: number | null;
}

/**
 * What this character's attack does to that target.
 *
 * The hit roll is **the same function `menace.ts` already has** — the server
 * uses one formula in both directions (`PlayerAttackType.GetAccuracyAgainstDefense`
 * is `Mob.DoCombat`'s roll with the arguments swapped), so importing it rather
 * than transcribing it twice is what stops the two sides drifting apart.
 *
 * Returns `null` rather than a figure whenever accuracy cannot be established:
 * the entire point of this module is to stop guessing at that.
 */
export function swing(
  sheet: ProwessSheet,
  weapon: ProwessWeapon | null,
  target: ProwessTarget,
  family: RealmFamily | null,
  attack: ProwessAttack = PLAIN_ATTACK
): Swing | null {
  // The hit roll below is GreaterMUD's, whoever stated the accuracy.
  if (family !== 'greatermud') return null;
  const acc = accuracy(sheet, weapon, family);
  if (acc === null) return null;
  // The roll is made at the accuracy the attack itself moves (`fixedAcc`).
  const aim =
    acc.value +
    ACCURACY_MOD[attack.kind] +
    (isMartial(attack.kind) ? (sheet.effects?.martialAccuracy[attack.kind] ?? 0) : 0);

  const hit = hitChance(aim, target.armourClass);
  const dodged = dodgedFraction(target.dodge, aim);
  const lands = Math.max(0, hit * (1 - dodged));

  /*
   * What `stat all` printed holds for the plain attack only: the sheet's own
   * range and blows, with every damage modifier applied and one for a bare
   * hand. Any other attack, and a plain one the sheet has not stated, is the
   * blow its own `CombatRound` makes: the weapon's range, else the bare
   * hand's 1–3, else a martial attack's level range (2026-10-01: a Mystic who
   * lost the staff kicked for 28 a round while every spot read unpriced).
   */
  const stated = attack.kind === 'attack' ? sheet.stated?.damage : undefined;
  const blow = stated === undefined ? blowOf(sheet, weapon, attack, family) : null;
  const low = stated?.min ?? (blow === null ? null : Math.floor(blow.low * blow.multiplier));
  const high = stated?.max ?? (blow === null ? null : Math.floor(blow.high * blow.multiplier));
  // The plain attack's blows are the sheet's where it printed them.
  const swings: Reckoning<number> | null =
    attack.kind === 'attack'
      ? swingsPerRound(sheet, weapon ?? BARE_HAND, family)
      : blow === null
        ? null
        : { value: blow.blows, from: blow.from };

  /*
   * `damage = rand(min, max) - DR / 10`, and a blow reduced to nothing is a
   * blow that did not land — the same reading `menace.expectedBlow` takes of
   * the same line, from the other side.
   */
  const resist = Math.max(0, Math.trunc(target.damageResist ?? 0));
  let mean: number | null = null;
  if (low !== null && high !== null && high >= low) {
    const first = Math.max(low, resist + 1);
    if (first <= high) {
      const count = high - first + 1;
      const width = high - low + 1;
      mean = (count * (first - resist + (high - resist))) / 2 / width;
    } else {
      mean = 0;
    }
  }

  /*
   * A critical blow is `rand(2 × max, 4 × max)`, three times the top of the
   * range on average, before the multiplier and the target's resistance.
   */
  const crit = critChance(sheet, attack.kind, family);
  if (mean !== null && high !== null && crit !== null && crit.value > 0) {
    const critical = Math.max(0, 3 * high - resist);
    mean = (1 - crit.value) * mean + crit.value * critical;
  }

  let rounds: Reckoning<number> | null = null;
  if (mean !== null && mean > 0 && target.health !== null && target.health > 0) {
    const perRound = lands * mean * Math.min(MAX_SWINGS, swings?.value ?? 1);
    if (perRound > 0) rounds = { value: target.health / perRound, from: 'bound' };
  }

  return {
    lands: { value: lands, from: 'bound' },
    damage: {
      value: mean ?? 0,
      from: mean === null ? 'bound' : stated !== undefined ? 'stated' : 'source'
    },
    swings,
    crit,
    range: low !== null && high !== null && high >= low ? { low, high } : null,
    rounds
  };
}

/** What a cast is expected to cost and how often it works. */
export interface CastOdds {
  /** 0–1, the server's `min(100, SpellCasting + Diff)` over a 1–100 roll. */
  chance: Reckoning<number>;
  /**
   * Mana this cast is *expected* to cost, which is not the listed cost.
   *
   * A failed cast still charges `max(1, mana / 2)`, so a caster choosing
   * between two spells is choosing between two expected costs. This is the
   * figure that decides, and the listed one never was.
   */
  expectedMana: Reckoning<number> | null;
}

/**
 * Whether a spell lands, and what it really costs — `Spell.Cast`,
 * `Spells/Spell.cs:2092`:
 *
 *     chance = min(MAX_SUCCESS_RATE, player.SpellCasting + spell.difficulty)
 *     roll   = rand(1, 100);  chance < roll is a failure
 *     on failure: CurMA -= max(1, manaCost / 2)
 *
 * `chance < roll` and not `<=`, so a chance of *n* succeeds on rolls 1..n —
 * exactly *n* per cent, and a chance of 0 never works. Both are transcribed
 * rather than rounded to the friendly reading.
 *
 * `Spells.Diff` is signed (−200 to 200 across both databases on this machine)
 * and had never been converted: `indexSpells` read twelve columns and not that
 * one, so the client held every input to this formula except the one that
 * varies per spell. Realm format 22 carries it.
 */
export function castOdds(
  spell: Pick<WorldSpell, 'mana' | 'difficulty'>,
  sheet: ProwessSheet,
  family: RealmFamily | null
): CastOdds | null {
  if (family !== 'greatermud') return null;
  if (sheet.spellcasting === null || spell.difficulty === undefined) return null;

  const chance =
    Math.max(0, Math.min(MAX_SUCCESS_RATE, Math.trunc(sheet.spellcasting + spell.difficulty))) /
    100;
  const mana = spell.mana;
  const expectedMana =
    mana === undefined
      ? null
      : {
          value: chance * mana + (1 - chance) * Math.max(1, Math.trunc(mana / 2)),
          from: 'source' as const
        };
  return { chance: { value: chance, from: 'source' }, expectedMana };
}

/**
 * The server's `SpellMageryType` codes (`Classes.MageryType`): which spells a
 * class may learn and which stat its mana tick is figured off. A Mystic casts
 * from kai (`Player.cs:2373`).
 */
export const MAGERY = { none: 0, mage: 1, priest: 2, druid: 3, bard: 4, mystic: 5 } as const;

/**
 * What `GetBaseMARegen` (`Player.cs:4550`) multiplies by for a class of this
 * magery type: INT, WIL, their mean, CHM; null for a Mystic (whose tick is a
 * flat 1), a class that casts nothing, or a stat not read.
 */
function manaStat(sheet: ProwessSheet, mageryType: number | null): number | null {
  switch (mageryType) {
    case MAGERY.mage:
      return sheet.intellect;
    case MAGERY.priest:
      return sheet.willpower;
    case MAGERY.druid:
      return sheet.intellect === null || sheet.willpower === null
        ? null
        : Math.trunc((sheet.intellect + sheet.willpower) / 2);
    case MAGERY.bard:
      return sheet.charm;
    default:
      return null;
  }
}

/** What comes back per tick, and how long a tick is. */
export interface Regeneration {
  health: Reckoning<number>;
  /** Null for a class that casts nothing — a Mystic's figure is the server's own 1. */
  mana: Reckoning<number> | null;
  /**
   * What a meditating tick returns: `GetBaseMARegen()`, flat, where the
   * passive tick adds `MARegen` with its ability bonus (`TimedEventManager`).
   * The same figure as `mana` wherever the bonus cannot be seen.
   */
  meditatingMana: Reckoning<number> | null;
  /** Seconds between ticks while standing. Resting ticks every 15s at triple the health rate. */
  tickSeconds: number;
  /** What resting returns per health tick — the sheet's `HP Regen: n/3n`. */
  restingHealth: Reckoning<number>;
}

/**
 * How fast this character comes back — `Player.cs:4813` and `:4863`.
 *
 *     HPRegen = max(1, (level + 20) * HEA / 750)
 *     MARegen = ((level + 20) * stat * (magery + 2)) / 1650
 *
 * where `stat` is chosen by the class row's `MageryType` (`manaStat`): INT
 * for a Mage, WIL for a Priest, their mean for a Druid, CHM for a Bard; a
 * Mystic regenerates a flat 1 (none at all while `KaiBind` is up, which the
 * sheet cannot see either: `stat all` states the `-1`). With the type unknown
 * the mana figure is null rather than one computed off the wrong stat.
 *
 * The ability bonuses on both are gear and spells the client cannot enumerate,
 * which makes each a floor: `bound` — until `stat all`'s own `HP Regen:` and
 * `MA Regen:` lines are in hand (`ProwessSheet.stated`), which answer instead.
 */
export function regeneration(
  sheet: ProwessSheet,
  mageryType: number | null,
  family: RealmFamily | null
): Regeneration | null {
  const said = sheet.stated;
  if (said?.health !== undefined && said.resting !== undefined) {
    // A class that casts nothing still prints `0/0`; its answer stays none.
    const caster = sheet.mageryLevel !== null;
    return {
      health: { value: said.health, from: 'stated' },
      mana: said.mana === undefined || !caster ? null : { value: said.mana, from: 'stated' },
      meditatingMana:
        said.meditating === undefined || !caster
          ? null
          : { value: said.meditating, from: 'stated' },
      tickSeconds: REGEN_TICK_SECONDS,
      restingHealth: { value: said.resting, from: 'stated' }
    };
  }
  if (family !== 'greatermud') return null;
  const held = need(sheet.level, sheet.health);
  if (held === null) return null;
  const [level, health] = held as [number, number];

  const base = Math.max(1, Math.trunc(((level + 20) * health) / 750));
  // `Player.HPRegen`: the `HPRegen` rows are a percentage of the tick.
  const hp = base + Math.trunc(((sheet.effects?.hpRegen ?? 0) * base) / 100);
  const magery = sheet.mageryLevel;
  const stat = manaStat(sheet, mageryType);
  const mana =
    magery === null
      ? null
      : mageryType === MAGERY.mystic
        ? { value: 1, from: 'bound' as const }
        : stat === null
          ? null
          : {
              value: Math.max(0, Math.trunc(((level + 20) * stat * (magery + 2)) / 1650)),
              from: 'bound' as const
            };

  return {
    health: { value: hp, from: 'bound' },
    mana,
    // The formula above is `GetBaseMARegen`'s; the bonus is what it cannot see.
    meditatingMana: mana,
    tickSeconds: REGEN_TICK_SECONDS,
    // The sheet prints `n/3n` and the rest tick is 15s: resting is three times
    // the rate on a tick eight times as often, which is the whole reason a
    // character sits down.
    restingHealth: { value: hp * 3, from: 'bound' }
  };
}
