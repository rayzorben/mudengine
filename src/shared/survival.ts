/**
 * Survivability: the whole room's fight, *run* rather than added up.
 *
 * `verdict.ts` answers what one monster costs in expectation. A player
 * entering a room asks a different question — *will I walk out of this?* —
 * and expectation cannot answer it: a fight is lost on the tail, on the round
 * where three blows land at once and the heal comes a round late. So this runs
 * the fight, many times, with the same arithmetic the verdict is priced on
 * (`prowess.swing`, `menace.hitChance`), and reports how often the character
 * walked out. See mudengine-automation › *The verdict is also run as a fight*.
 */
import { guardsFirst, type GuardSubject } from './guards';
import {
  expectedBlow,
  facing,
  landsOn,
  mobSwingsPerRound,
  weighRoom,
  type MenacePlayer,
  type MenaceSubject,
  type MenaceWeights
} from './menace';
import {
  MAX_SWINGS,
  swing,
  type ProwessSheet,
  type ProwessWeapon,
  type Reckoning
} from './prowess';
import type { RealmFamily } from './realm';
import { rankByVerdict, targetOf, verdictFor, type TargetEntity } from './verdict';
import type { MobAttack, MobProfile } from './world';

/** One thing in the room that will fight, as the realm knows it. */
export interface SurvivalFoe {
  name: string;
  subject: MenaceSubject & TargetEntity & GuardSubject;
}

/** The heal the automation would cast, as it is configured. */
export interface SurvivalHeal {
  /** Cast when health falls under this fraction of maximum. */
  below: number;
  /** And keep casting until it reaches this fraction; 0 is one cast at the threshold. */
  to: number;
  /** What one cast restores, low and high. */
  restores: [number, number];
  cost: number;
  /** Never cast below this fraction of maximum mana; 0 always casts. */
  minMana: number;
}

export interface SurvivalInput {
  hp: number;
  hpMax: number;
  mana: number | null;
  manaMax: number | null;
  player: MenacePlayer;
  sheet: ProwessSheet;
  weapon: ProwessWeapon | null;
  family: RealmFamily | null;
  weights: MenaceWeights;
  foes: SurvivalFoe[];
  /**
   * A caster's blow where the swing says nothing, by foe: expected damage a
   * round and the mana a round of it costs. Null where the swing answers.
   */
  casting: Array<{ perRound: number; manaPerRound: number } | null>;
  heal: SurvivalHeal | null;
  /** Health regained a round, from the regeneration tick. */
  regenPerRound: number;
  /** Blessings that lapse during the fight: the round each lapses and what the recast costs. */
  recasts: Array<{ round: number; cost: number }>;
  /** What counts as safe and as merely risky, as a share of fights survived. */
  levels: { safeAbove: number; riskyAbove: number };
  trials: number;
  roundCap: number;
  /** Fixed by default, so the same room and the same character always read the same. */
  seed?: number;
}

export type SurvivalLevel = 'safe' | 'risky' | 'deadly';

export interface Survival {
  /** The share of fights the character walked out of, 0..1. */
  survives: number;
  level: SurvivalLevel;
  /** Rounds a fight took, on average. Measured, since it was run. */
  rounds: Reckoning<number>;
  /** Health left at the end, the median over the fights survived; null when none was. */
  hpLeft: number | null;
  /** Heals cast a fight, on average. */
  heals: number;
  trials: number;
}

/**
 * Runs the room. Null when the fight cannot be run honestly: a foe the realm
 * cannot weigh, or a character with no way to hurt any of them — an unknown
 * is never the reassuring answer and never the alarming one.
 */
export function simulateFight(input: SurvivalInput): Survival | null {
  const { foes, hpMax } = input;
  if (foes.length === 0 || input.hp <= 0 || hpMax <= 0) return null;
  if (foes.some((foe) => foe.subject.profiles === undefined || foe.subject.profiles.length === 0)) {
    return null;
  }

  /*
   * Two weighings of the same room. The engine's, for the order the character
   * takes them in — the same `rankByVerdict` auto-combat swings by, so the
   * fight run here is the fight the engine would fight. And one with every
   * non-hit-point hazard priced at nothing, because a round held or afraid is
   * a cost to the *order* and not a wound: only damage, drain and poison take
   * health off, and health is what this counts.
   */
  const subjects = foes.map((foe) => foe.subject);
  const ranked = weighRoom(subjects, input.player, input.weights);
  const wounds = weighRoom(subjects, input.player, {
    ...input.weights,
    held: 0,
    confused: 0,
    blinded: 0,
    slowed: 0,
    afraid: 0,
    summon: 0,
    teleported: 0
  });
  const verdicts = subjects.map((subject, index) =>
    verdictFor(ranked[index] ?? null, targetOf(subject), input.sheet, input.weapon, input.family)
  );
  // A guard before what it protects, as the engine swings (`guards.ts`).
  const order = guardsFirst(
    rankByVerdict(verdicts),
    foes.map((foe) => ({ name: foe.name, mob: foe.subject }))
  );

  const foeSides = subjects.map((subject, index) => {
    const wound = wounds[index] ?? null;
    const menaceHp = wound?.hp ?? subject.hp ?? null;
    const target = targetOf(subject);
    const blow = swing(
      input.sheet,
      input.weapon,
      {
        armourClass: target.armourClass ?? null,
        damageResist: target.damageResist ?? null,
        dodge: target.dodge ?? null,
        health: menaceHp
      },
      input.family
    );
    const attack = blow !== null && blow.rounds !== null ? blow : null;
    const cast = input.casting[index] ?? null;
    // Its blows meet the protection that applies to it (`menace.facing`).
    const against = facing(input.player, subject);
    return {
      hp: menaceHp !== null && menaceHp > 0 ? menaceHp : 1,
      against,
      profile: worstProfile(subject.profiles ?? [], against),
      // The expected harm of everything that is not a blow: hit spells, casts,
      // lasting damage. Sampled nowhere, since the variance that kills is the
      // blows'.
      spellHarm: wound === null ? 0 : Math.max(0, wound.perRound - wound.blows),
      onDeath: wound?.onDeath ?? 0,
      attack,
      cast
    };
  });
  // A fight the character cannot win is not one this can price.
  if (foeSides.every((side) => side.attack === null && side.cast === null)) return null;

  const random = mulberry32(input.seed ?? 0x9e3779b9);
  const trials = Math.max(1, Math.trunc(input.trials));
  const roundCap = Math.max(1, Math.trunc(input.roundCap));
  const heal = input.heal;
  // The sheet's own range where `stat all` still states it: `prowess.swing`'s rule.
  const stated = input.sheet.stated?.damage;
  const weaponLow = stated?.min ?? input.weapon?.min;
  const weaponHigh = stated?.max ?? input.weapon?.max;

  let survived = 0;
  let roundsTotal = 0;
  let healsTotal = 0;
  const leftovers: number[] = [];

  for (let trial = 0; trial < trials; trial += 1) {
    let hp = input.hp;
    let mana = input.mana;
    const alive = foeSides.map((side) => side.hp);
    let healing = false;
    let heals = 0;
    let regenCarry = 0;
    let round = 0;
    let dead = false;

    while (round < roundCap) {
      round += 1;
      const targetIndex = order.find((index) => alive[index]! > 0);
      if (targetIndex === undefined) break;

      // The character's turn: a heal at the threshold, else a blow.
      let cast = false;
      if (heal !== null && mana !== null) {
        const fraction = hp / hpMax;
        const wants: boolean =
          fraction < heal.below || (heal.to > 0 && healing && fraction < heal.to);
        healing = wants;
        if (wants) {
          const floor =
            heal.minMana <= 0
              ? true
              : input.manaMax !== null && input.manaMax > 0 && mana / input.manaMax >= heal.minMana;
          if (floor && mana >= heal.cost) {
            hp = Math.min(hpMax, hp + between(random, heal.restores[0], heal.restores[1]));
            mana -= heal.cost;
            heals += 1;
            cast = true;
          }
        }
      }
      if (!cast) {
        const side = foeSides[targetIndex]!;
        const target = targetOf(subjects[targetIndex]);
        let dealt = 0;
        if (side.attack !== null) {
          const swings = sampledCount(random, Math.min(MAX_SWINGS, side.attack.swings?.value ?? 1));
          const resist = Math.max(0, Math.trunc(target.damageResist ?? 0));
          for (let n = 0; n < swings; n += 1) {
            if (random() >= side.attack.lands.value) continue;
            dealt +=
              weaponLow !== undefined && weaponHigh !== undefined
                ? Math.max(0, between(random, weaponLow, weaponHigh) - resist)
                : side.attack.damage.value;
          }
        } else if (side.cast !== null) {
          if (mana === null || mana >= side.cast.manaPerRound) {
            dealt = side.cast.perRound;
            if (mana !== null) mana -= side.cast.manaPerRound;
          }
        }
        alive[targetIndex] = alive[targetIndex]! - dealt;
        if (alive[targetIndex]! <= 0) hp -= side.onDeath;
      }

      // Every foe still standing takes its round.
      for (const [index, side] of foeSides.entries()) {
        if (alive[index]! <= 0) continue;
        hp -= side.spellHarm + meleeRound(random, side.profile, side.against);
      }
      if (hp <= 0) {
        dead = true;
        break;
      }

      regenCarry += input.regenPerRound;
      const whole = Math.floor(regenCarry);
      if (whole > 0) {
        hp = Math.min(hpMax, hp + whole);
        regenCarry -= whole;
      }
      if (mana !== null) {
        for (const recast of input.recasts) {
          if (recast.round === round && mana >= recast.cost) mana -= recast.cost;
        }
      }
    }

    roundsTotal += round;
    healsTotal += heals;
    if (!dead) {
      survived += 1;
      leftovers.push(Math.max(0, hp));
    }
  }

  const survives = survived / trials;
  leftovers.sort((a, b) => a - b);
  return {
    survives,
    level:
      survives >= input.levels.safeAbove
        ? 'safe'
        : survives >= input.levels.riskyAbove
          ? 'risky'
          : 'deadly',
    rounds: { value: roundsTotal / trials, from: 'measured' },
    hpLeft: leftovers.length === 0 ? null : leftovers[Math.floor(leftovers.length / 2)]!,
    heals: healsTotal / trials,
    trials
  };
}

/**
 * The profile that lands the most, in expectation — `weighRoom` prices a
 * monster by its worst row, and the fight is run against the same one.
 */
function worstProfile(profiles: readonly MobProfile[], player: MenacePlayer): MobProfile {
  let best = profiles[0]!;
  let most = -1;
  for (const profile of profiles) {
    const swings = mobSwingsPerRound(profile.attacks);
    let perSwing = 0;
    for (const attack of profile.attacks) {
      if (attack.kind !== 'melee') continue;
      const { damage } = expectedBlow(attack.min, attack.max, player.damageResist);
      perSwing += attack.chance * landsOn(attack.accuracy, player) * damage;
    }
    if (swings * perSwing > most) {
      most = swings * perSwing;
      best = profile;
    }
  }
  return best;
}

/**
 * One round of a monster's blows, rolled the way `rowPerRound` expects them:
 * so many swings a round, each choosing an attack by its chance, each landing
 * by accuracy against armour class and dodge, each doing its range less
 * resistance.
 */
function meleeRound(random: () => number, profile: MobProfile, player: MenacePlayer): number {
  const swings = sampledCount(random, mobSwingsPerRound(profile.attacks));
  const resist = Math.max(0, Math.trunc(player.damageResist ?? 0));
  let harm = 0;
  for (let n = 0; n < swings; n += 1) {
    const attack = pickAttack(random, profile.attacks);
    if (attack === null || attack.kind !== 'melee') continue;
    if (random() >= landsOn(attack.accuracy, player)) continue;
    harm += Math.max(0, between(random, attack.min, attack.max) - resist);
  }
  return harm;
}

/** An attack by its chance; null when the chances leave the swing empty. */
function pickAttack(random: () => number, attacks: readonly MobAttack[]): MobAttack | null {
  const total = attacks.reduce((sum, attack) => sum + Math.max(0, attack.chance), 0);
  if (total <= 0) return null;
  let roll = random() * Math.max(1, total);
  for (const attack of attacks) {
    roll -= Math.max(0, attack.chance);
    if (roll < 0) return attack;
  }
  return null;
}

/** A fractional expectation as a whole count: the floor, and one more with the fraction's chance. */
function sampledCount(random: () => number, expected: number): number {
  const whole = Math.floor(expected);
  return whole + (random() < expected - whole ? 1 : 0);
}

/** A whole number in `[low, high]`, either way round. */
function between(random: () => number, low: number, high: number): number {
  const a = Math.min(low, high);
  const b = Math.max(low, high);
  return a + Math.floor(random() * (b - a + 1));
}

/** Mulberry32: a small, seedable generator, so a room reads the same every time it is weighed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
