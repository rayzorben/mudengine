/**
 * Survivability: the whole room's fight, *run* rather than added up.
 *
 * `verdict.ts` answers what one monster costs in expectation. A player
 * entering a room asks a different question, *will I walk out of this?*, and
 * expectation cannot answer it: a fight is lost on the tail, on the round
 * where three spears land at once and the heal comes a round late. So this
 * runs the fight many times, the character's blows by `prowess.swing` and
 * every monster's round rolled by `mobRound.ts` (MME's attack sim), and
 * reports how often the character walked out and what it cost on the way.
 * See mudengine-automation › *The verdict is also run as a fight*.
 */
import { between, mulberry32, sampledCount } from './dice';
import { guardsFirst, type GuardSubject } from './guards';
import { weighRoom, type MenacePlayer, type MenaceSubject, type MenaceWeights } from './menace';
import {
  expectedHarm,
  freshMobState,
  mobModel,
  rollMobRound,
  spellEffect,
  type MobModel,
  type MobState
} from './mobRound';
import {
  MAX_SWINGS,
  swing,
  type ProwessSheet,
  type ProwessWeapon,
  type Reckoning
} from './prowess';
import type { RealmFamily } from './realm';
import { rankByVerdict, targetOf, verdictFor, type TargetEntity } from './verdict';

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

/** What counts as safe and as merely risky: shares of fights survived that must be *exceeded*. */
export interface SurvivalLevels {
  safeAbove: number;
  riskyAbove: number;
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
  /**
   * The room's foes, every one of them in every fight; or, with `draw`, the
   * pool a lair spawns from.
   */
  foes: SurvivalFoe[];
  /**
   * A lair: each fight meets this many foes drawn from `foes`, each one any
   * of them alike, as `RegenSlot` fills a lair's slot from its rows.
   */
  draw?: number;
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
  levels: SurvivalLevels;
  trials: number;
  roundCap: number;
  /** Rounds at which the fight is read part way (`Survival.horizons`); empty reads none. */
  horizons?: readonly number[];
  /** Fixed by default, so the same room and the same character always read the same. */
  seed?: number;
}

export type SurvivalLevel = 'safe' | 'risky' | 'deadly';

/** The rounds a fight is read at part way (todo 03): the first, then doubling out to 24. */
export const SURVIVAL_HORIZONS = [1, 3, 6, 12, 24] as const;

/** The fights read at one round. A fight already over is read as it ended. */
export interface SurvivalHorizon {
  rounds: number;
  /** The share of fights the character was still standing in. */
  standing: number;
  /** The share of fights already won: every foe down. */
  won: number;
  /** Health lost by this round, before any heal gave it back: least, mean, most. */
  lost: { least: number; mean: number; most: number };
}

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
  /** The most health lost in any one round of any fight. */
  worstRound: number;
  horizons: SurvivalHorizon[];
  trials: number;
}

/**
 * A fight the odds book holds: waiting for the character's own figures to be
 * read, queued to be run, one `simulateFight` cannot run (it answered null),
 * or the run.
 */
export type Odds =
  | { kind: 'unread' }
  | { kind: 'pending' }
  | { kind: 'unrun' }
  | { kind: 'run'; survival: Survival };

/** The level a share of fights survived reads as. */
export function survivalLevel(survives: number, levels: SurvivalLevels): SurvivalLevel {
  if (survives > levels.safeAbove) return 'safe';
  if (survives > levels.riskyAbove) return 'risky';
  return 'deadly';
}

/** One foe as the fight meets it, compiled once for every trial. */
interface FoeSide {
  hp: number;
  model: MobModel;
  attack: NonNullable<ReturnType<typeof swing>> | null;
  cast: { perRound: number; manaPerRound: number } | null;
  resist: number;
  death: ReturnType<typeof spellEffect>;
}

/**
 * Runs the room. Null for a foe the realm cannot weigh, or a character with
 * no way to hurt any of them: an unknown is never the reassuring answer and
 * never the alarming one.
 */
export function simulateFight(input: SurvivalInput): Survival | null {
  const { foes, hpMax } = input;
  if (foes.length === 0 || input.hp <= 0 || hpMax <= 0) return null;
  if (foes.some((foe) => foe.subject.profiles === undefined || foe.subject.profiles.length === 0)) {
    return null;
  }

  /*
   * The order the character takes them in is the engine's: `rankByVerdict`
   * on the room's weighing, a guard before what it protects (`guards.ts`).
   * For a lair it is the pool's order, and each fight takes what it drew in
   * that order.
   */
  const subjects = foes.map((foe) => foe.subject);
  const ranked = weighRoom(subjects, input.player, input.weights);
  const verdicts = subjects.map((subject, index) =>
    verdictFor(ranked[index] ?? null, targetOf(subject), input.sheet, input.weapon, input.family)
  );
  const order = guardsFirst(
    rankByVerdict(verdicts),
    foes.map((foe) => ({ name: foe.name, mob: foe.subject }))
  );
  const position = new Map(order.map((index, at) => [index, at]));

  const sides: FoeSide[] = subjects.map((subject, index) => {
    const target = targetOf(subject);
    const blow = swing(
      input.sheet,
      input.weapon,
      {
        armourClass: target.armourClass ?? null,
        damageResist: target.damageResist ?? null,
        dodge: target.dodge ?? null,
        health: subject.hp ?? null
      },
      input.family
    );
    return {
      hp: subject.hp !== undefined && subject.hp > 0 ? subject.hp : 1,
      model: worstModel(subject, input.player),
      attack: blow !== null && blow.rounds !== null ? blow : null,
      cast: input.casting[index] ?? null,
      resist: Math.max(0, Math.trunc(target.damageResist ?? 0)),
      death:
        subject.deathSpell === undefined
          ? null
          : spellEffect(subject.spells?.[subject.deathSpell], 0, input.player)
    };
  });
  // A fight the character cannot win is not one this can price.
  if (sides.every((side) => side.attack === null && side.cast === null)) return null;

  const random = mulberry32(input.seed ?? 0x9e3779b9);
  const trials = Math.max(1, Math.trunc(input.trials));
  const roundCap = Math.max(1, Math.trunc(input.roundCap));
  const horizons = [...new Set(input.horizons ?? [])]
    .filter((rounds) => rounds > 0)
    .sort((a, b) => a - b);
  const reads = horizons.map(() => ({ standing: 0, won: 0, lost: [] as number[] }));
  const count = input.draw === undefined ? null : Math.max(1, Math.trunc(input.draw));
  // The sheet's own range where `stat all` still states it: `prowess.swing`'s rule.
  const stated = input.sheet.stated?.damage;
  const weaponLow = stated?.min ?? input.weapon?.min;
  const weaponHigh = stated?.max ?? input.weapon?.max;

  let survived = 0;
  let roundsTotal = 0;
  let healsTotal = 0;
  let worstRound = 0;
  const leftovers: number[] = [];

  for (let trial = 0; trial < trials; trial += 1) {
    const met =
      count === null
        ? order
        : Array.from({ length: count }, () => Math.floor(random() * sides.length)).sort(
            (a, b) => position.get(a)! - position.get(b)!
          );
    const alive = met.map((index) => sides[index]!.hp);
    const states: MobState[] = met.map(() => freshMobState());
    let hp = input.hp;
    let mana = input.mana;
    let healing = false;
    let heals = 0;
    let regenCarry = 0;
    let held = 0;
    let lost = 0;
    let round = 0;
    let dead = false;
    let next = 0;

    const read = (upTo: number, won: boolean): void => {
      while (next < horizons.length && horizons[next]! <= upTo) {
        const at = reads[next]!;
        if (!dead) at.standing += 1;
        if (won) at.won += 1;
        at.lost.push(lost);
        next += 1;
      }
    };

    while (round < roundCap) {
      const target = alive.findIndex((health) => health > 0);
      if (target === -1) break;
      round += 1;

      if (held > 0) {
        held -= 1;
      } else if (!healed()) {
        const side = sides[met[target]!]!;
        const dealt = strike(side);
        alive[target] = alive[target]! - dealt;
        if (alive[target]! <= 0 && side.death !== null) {
          const harm = side.death.high > 0 ? between(random, side.death.low, side.death.high) : 0;
          hp -= harm;
          lost += harm;
        }
      }

      // Every foe still standing takes its round.
      let roundHarm = 0;
      for (const [slot, index] of met.entries()) {
        if (alive[slot]! <= 0) continue;
        const outcome = rollMobRound(random, sides[index]!.model, states[slot]!);
        roundHarm += outcome.harm;
        held = Math.max(held, outcome.held);
        if (outcome.mended > 0) {
          alive[slot] = Math.min(sides[index]!.hp, alive[slot]! + outcome.mended);
        }
      }
      hp -= roundHarm;
      lost += roundHarm;
      worstRound = Math.max(worstRound, roundHarm);
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
      read(round, false);
    }
    read(Number.POSITIVE_INFINITY, !dead && alive.every((health) => health <= 0));

    roundsTotal += round;
    healsTotal += heals;
    if (!dead) {
      survived += 1;
      leftovers.push(Math.max(0, hp));
    }

    /** The character's turn spent on the heal `AutoHeal` would cast, if it would. */
    function healed(): boolean {
      const heal = input.heal;
      if (heal === null || mana === null) return false;
      const fraction = hp / hpMax;
      const wants = fraction < heal.below || (heal.to > 0 && healing && fraction < heal.to);
      healing = wants;
      if (!wants) return false;
      const floor =
        heal.minMana <= 0 ||
        (input.manaMax !== null && input.manaMax > 0 && mana / input.manaMax >= heal.minMana);
      if (!floor || mana < heal.cost) return false;
      hp = Math.min(hpMax, hp + between(random, heal.restores[0], heal.restores[1]));
      mana -= heal.cost;
      heals += 1;
      return true;
    }

    /** The character's blows at one foe this round. */
    function strike(side: FoeSide): number {
      if (side.attack !== null) {
        const swings = sampledCount(random, Math.min(MAX_SWINGS, side.attack.swings?.value ?? 1));
        let dealt = 0;
        for (let n = 0; n < swings; n += 1) {
          if (random() >= side.attack.lands.value) continue;
          dealt +=
            weaponLow !== undefined && weaponHigh !== undefined
              ? Math.max(0, between(random, weaponLow, weaponHigh) - side.resist)
              : side.attack.damage.value;
        }
        return dealt;
      }
      if (side.cast !== null && (mana === null || mana >= side.cast.manaPerRound)) {
        if (mana !== null) mana -= side.cast.manaPerRound;
        return side.cast.perRound;
      }
      return 0;
    }
  }

  const survives = survived / trials;
  leftovers.sort((a, b) => a - b);
  return {
    survives,
    level: survivalLevel(survives, input.levels),
    rounds: { value: roundsTotal / trials, from: 'measured' },
    hpLeft: leftovers.length === 0 ? null : leftovers[Math.floor(leftovers.length / 2)]!,
    heals: healsTotal / trials,
    worstRound,
    horizons: horizons.map((rounds, at) => {
      const { standing, won, lost } = reads[at]!;
      return {
        rounds,
        standing: standing / trials,
        won: won / trials,
        lost: {
          least: lost.length === 0 ? 0 : Math.min(...lost),
          mean: lost.length === 0 ? 0 : lost.reduce((sum, each) => sum + each, 0) / lost.length,
          most: lost.length === 0 ? 0 : Math.max(...lost)
        }
      };
    }),
    trials
  };
}

/**
 * The row that harms the most, in expectation as the draw deals it
 * (`expectedHarm`): a name holding several rows is met as its worst.
 */
function worstModel(subject: MenaceSubject, player: MenacePlayer): MobModel {
  let worst: MobModel | null = null;
  let most = -1;
  for (const profile of subject.profiles ?? []) {
    const model = mobModel(subject, profile, player);
    const harm = expectedHarm(model);
    if (harm > most) {
      most = harm;
      worst = model;
    }
  }
  return worst!;
}
