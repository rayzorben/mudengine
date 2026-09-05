import { hitChance } from './menace';
import type { RealmFamily } from './realm';
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
 * (docs/greatermud/player-and-world.md). No recorded session has ever sent it,
 * so nothing here can be `stated` yet — but the ladder has the rung, and the
 * moment `probe:statall` produces a pattern the sheet's figure wins and these
 * formulas are demoted to what they are best at: *what if I wore this, what if
 * I gained a level*. Until then everything below is `source`, and the surfaces
 * that draw it say so.
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

/**
 * Where dodge stops paying for itself — `GMUDServer.SPECIAL_DODGE_POINT`.
 *
 * The server raises it by ten for a Mystic or a Ninja *defending*; that branch
 * is on the target's class and belongs to whatever asks about being hit, not
 * to a character asking about its own swing.
 */
const SPECIAL_DODGE_POINT = 45;

/** `TimedEventManager.RegenTickTime`, in seconds. */
export const REGEN_TICK_SECONDS = 121;

/** `TGSGlobals.diminishing_returns` — a triangular-number taper, transcribed. */
function diminishingReturns(value: number, scale: number): number {
  if (value < 0) return -diminishingReturns(-value, scale);
  const mult = value / scale;
  return ((Math.sqrt(8 * mult + 1) - 1) / 2) * scale;
}

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

  let acc = 1;
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

  return { value: Math.max(1, acc), from: weapon === null ? 'source' : 'bound' };
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
  return { value: Math.max(0, value), from: 'bound' };
}

/**
 * How much of a swing a defender's dodge turns away, as a fraction —
 * `PlayerAttackType.GetDodgePercentAgainstDefense`.
 *
 *     dodge% = dodge² / max((acc² / 14) / 10, 1)
 *
 * with the same denominator the hit roll uses, and above `SPECIAL_DODGE_POINT`
 * the excess is tapered through `diminishing_returns(excess, 4)`. A defender
 * whose dodge is not known dodges nothing, which is the answer that makes the
 * most swings land — the safe direction for a character deciding what to
 * attack.
 */
export function dodgedFraction(dodgeValue: number | null, accuracyValue: number): number {
  const held = Math.max(0, Math.trunc(dodgeValue ?? 0));
  if (held === 0) return 0;
  const reach = Math.max(Math.trunc(Math.trunc((accuracyValue * accuracyValue) / 14) / 10), 1);
  let percent = Math.trunc((held * held) / reach);
  if (percent > SPECIAL_DODGE_POINT) {
    percent =
      SPECIAL_DODGE_POINT + Math.trunc(diminishingReturns(percent - SPECIAL_DODGE_POINT, 4));
  }
  return Math.min(1, Math.max(0, percent) / 100);
}

/**
 * How many blows a round buys — `CalcEnergyUsed`, `Player.cs:5503`, against the
 * 1,000 energy a round grants.
 *
 *     energy  = Speed * 1000 / ((((level * (combat + 2)) + 45) * (AGI + 150)) * 1500 / 9000)
 *     energy *= ((StrReq - STR) * 3 + 200) / 200      only while STR < StrReq
 *     energy *= (enc% / 2 + 75) / 100
 *
 * At least one: a round always buys a swing, however slow the weapon, because
 * the server's loop spends energy it has and this client must not report a
 * character that cannot attack at all.
 */
export function swingsPerRound(
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

  const divisor = Math.trunc(((level * (combat + 2) + 45) * (agility + 150) * 1500) / 9000);
  if (divisor <= 0) return null;
  let energy = (speed * 1000) / divisor;
  const strReq = weapon?.strength;
  if (strReq !== undefined && sheet.strength !== null && sheet.strength < strReq) {
    energy *= ((strReq - sheet.strength) * 3 + 200) / 200;
  }
  const enc = sheet.encumbrancePercent ?? 100;
  energy *= (enc / 2 + 75) / 100;
  if (energy <= 0) return null;
  return { value: Math.max(1, Math.floor(1000 / energy)), from: 'source' };
}

/** What a swing is expected to do to one target, and how long the target lasts. */
export interface Swing {
  /** Chance one blow lands, 0–1: the hit roll less what dodge turns away. */
  lands: Reckoning<number>;
  /** Mean damage of a blow that lands, after the target's damage resistance. */
  damage: Reckoning<number>;
  /** Blows a round buys, from `swingsPerRound`. Null when no weapon is known. */
  swings: Reckoning<number> | null;
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
  family: RealmFamily | null
): Swing | null {
  const acc = accuracy(sheet, weapon, family);
  if (acc === null) return null;

  const hit = hitChance(acc.value, target.armourClass);
  const dodged = dodgedFraction(target.dodge, acc.value);
  const lands = Math.max(0, hit * (1 - dodged));

  /*
   * `damage = rand(min, max) - DR / 10`, and a blow reduced to nothing is a
   * blow that did not land — the same reading `menace.expectedBlow` takes of
   * the same line, from the other side. An unarmed character has no range the
   * realm can state, so damage is `null` rather than zero: martial arts is on
   * the sheet and its conversion to a range is not in hand.
   */
  const low = weapon?.min;
  const high = weapon?.max;
  const resist = Math.max(0, Math.trunc(target.damageResist ?? 0));
  let mean: number | null = null;
  if (low !== undefined && high !== undefined && high >= low) {
    const first = Math.max(low, resist + 1);
    if (first <= high) {
      const count = high - first + 1;
      const width = high - low + 1;
      mean = (count * (first - resist + (high - resist))) / 2 / width;
    } else {
      mean = 0;
    }
  }

  const swings = swingsPerRound(sheet, weapon, family);
  let rounds: Reckoning<number> | null = null;
  if (mean !== null && mean > 0 && target.health !== null && target.health > 0) {
    const perRound = lands * mean * (swings?.value ?? 1);
    if (perRound > 0) rounds = { value: target.health / perRound, from: 'bound' };
  }

  return {
    lands: { value: lands, from: 'bound' },
    damage: { value: mean ?? 0, from: mean === null ? 'bound' : 'source' },
    swings,
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

/** What comes back per tick, and how long a tick is. */
export interface Regeneration {
  health: Reckoning<number>;
  /** Null for a class that casts nothing — a Mystic's figure is the server's own 1. */
  mana: Reckoning<number> | null;
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
 * where `stat` is INT for a Mage, WIL for a Priest, their mean for a Druid and
 * CHM for a Bard; a Mystic regenerates 1. This client cannot tell those four
 * apart from the class name alone without the realm's magery type, so the
 * *stat* is chosen by `mageryLevel` where the caller knows which it is and the
 * mana figure is `null` otherwise — an honest absence rather than a number
 * computed off the wrong stat.
 *
 * The ability bonuses on both are gear and spells the client cannot enumerate,
 * which makes each a floor: `bound`, and the sheet's own `HP Regen:` line —
 * printed by `stat all`, a command no recorded session has ever sent — is what
 * will replace it with `stated`.
 */
export function regeneration(
  sheet: ProwessSheet,
  manaStat: number | null,
  family: RealmFamily | null
): Regeneration | null {
  if (family !== 'greatermud') return null;
  const held = need(sheet.level, sheet.health);
  if (held === null) return null;
  const [level, health] = held as [number, number];

  const hp = Math.max(1, Math.trunc(((level + 20) * health) / 750));
  const magery = sheet.mageryLevel;
  const mana =
    magery === null || manaStat === null
      ? null
      : {
          value: Math.max(0, Math.trunc(((level + 20) * manaStat * (magery + 2)) / 1650)),
          from: 'bound' as const
        };

  return {
    health: { value: hp, from: 'bound' },
    mana,
    tickSeconds: REGEN_TICK_SECONDS,
    // The sheet prints `n/3n` and the rest tick is 15s: resting is three times
    // the rate on a tick eight times as often, which is the whole reason a
    // character sits down.
    restingHealth: { value: hp * 3, from: 'bound' }
  };
}
