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
import { blessedPlayer, negated, sumEffects, type BlessingEffect } from './blessingeffects';
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
  type ProwessAttack,
  type ProwessSheet,
  type ProwessWeapon,
  type Reckoning
} from './prowess';
import type { RealmFamily } from './realm';
import { mendsTheRound } from './spellchoice';
import { prowessTargetOf, rankByVerdict, targetOf, verdictFor, type TargetEntity } from './verdict';

/** One thing in the room that will fight, as the realm knows it. */
export interface SurvivalFoe {
  name: string;
  subject: MenaceSubject & TargetEntity & GuardSubject;
  /**
   * Swings only once the character has struck it: a monster that does not
   * attack on sight (`Mob.ShouldMobAttackTarget`), met in a lair the
   * character hunts, and brought in by its own `RecentAttackers` alone.
   * Absent swings from the first round.
   */
  waits?: boolean;
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
  /**
   * What a cast is expected to mend where Auto Choose Best Heal named it: it
   * is cast only in a round it mends (`mendsTheRound`). Null for the
   * configured spell, cast whatever the round is worth.
   */
  chosenMends: number | null;
}

/** A blessing up that lapses during the fight. */
export interface Recast {
  /** The round it lapses in. */
  round: number;
  /**
   * The mana its recast costs; null where this character does not recast it
   * in a fight (somebody else's, not kept up, or unpriced), so it is gone.
   */
  cost: number | null;
  /** The row's mana floor: never recast below this fraction of maximum mana; 0 always. */
  minMana: number;
  /**
   * What it adds while up, taken off for the rest of the fight when it goes
   * unrecast; null where it carries nothing the fight weighs.
   */
  effect: BlessingEffect | null;
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
  /** The attack typed (`combat.attack`); the plain one where absent. */
  attack?: ProwessAttack;
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
   * A caster's blow, by foe: expected damage a round and the mana a round of
   * it costs. Cast while the mana pays for it, as `AttackSpells` casts the
   * chosen spell before the melee round; the swing once it runs dry. Null
   * where the character casts nothing at it.
   */
  casting: Array<{ perRound: number; manaPerRound: number } | null>;
  heal: SurvivalHeal | null;
  /** Health regained a round, from the regeneration tick. */
  regenPerRound: number;
  /** Blessings that lapse during the fight, recast while the mana pays and lost when it does not. */
  recasts: Recast[];
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
  /**
   * Health down when a fight ended, heals and regeneration counted, the mean
   * over every fight: what resting has to give back.
   */
  lostMean: number;
  /** The most health lost in any one round of any fight. */
  worstRound: number;
  /** Mana spent a fight on casts, heals and recasts, the mean over every fight: what resting for mana gives back; null with the pool unread. */
  manaMean: number | null;
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
  const fight = startFight(input);
  if (fight === null) return null;
  fight.run(() => false);
  return fight.result();
}

/**
 * A `simulateFight` run a few trials at a time: `run` goes on until `stop`
 * says so after a trial, and the next call carries on the same draws, so the
 * result is the one a single call gives. One lair's fight was 250 to 800ms
 * of main in one piece, past every slice the odds book keeps (2026-10-02).
 */
export interface FightTrials {
  readonly done: boolean;
  /** Runs trials until all are run or `stop` answers true after one. */
  run(stop: () => boolean): void;
  /** What the trials run so far came to; read once `done`. */
  result(): Survival;
}

/** The fight set up for its trials, or null where `simulateFight` would answer null. */
export function startFight(input: SurvivalInput): FightTrials | null {
  const { foes, hpMax } = input;
  if (foes.length === 0 || input.hp <= 0 || hpMax <= 0) return null;
  // Unread is not priced; a row stating no attack at all (the drunken gambler) deals nothing.
  if (foes.some((foe) => foe.subject.profiles === undefined)) return null;

  /*
   * The order the character takes them in is the engine's: `rankByVerdict`
   * on the room's weighing, a guard before what it protects (`guards.ts`).
   * For a lair it is the pool's order, and each fight takes what it drew in
   * that order.
   */
  const subjects = foes.map((foe) => foe.subject);
  const ranked = weighRoom(subjects, input.player, input.weights);
  const verdicts = subjects.map((subject, index) =>
    verdictFor(
      ranked[index] ?? null,
      targetOf(subject),
      input.sheet,
      input.weapon,
      input.family,
      input.attack
    )
  );
  const order = guardsFirst(
    rankByVerdict(verdicts),
    foes.map((foe) => ({ name: foe.name, mob: foe.subject }))
  );
  const position = new Map(order.map((index, at) => [index, at]));

  /** Every foe compiled against the character as `player` and `sheet` say it fights. */
  const compile = (player: MenacePlayer, sheet: ProwessSheet): FoeSide[] =>
    subjects.map((subject, index) => {
      const target = targetOf(subject);
      const blow = swing(sheet, input.weapon, prowessTargetOf(subject), input.family, input.attack);
      return {
        hp: subject.hp !== undefined && subject.hp > 0 ? subject.hp : 1,
        model: worstModel(subject, player),
        attack: blow !== null && blow.rounds !== null ? blow : null,
        cast: input.casting[index] ?? null,
        resist: Math.max(0, Math.trunc(target.damageResist ?? 0)),
        death:
          subject.deathSpell === undefined
            ? null
            : spellEffect(subject.spells?.[subject.deathSpell], 0, player)
      };
    });
  const sides = compile(input.player, input.sheet);
  // A fight the character cannot win is not one this can price.
  if (sides.every((side) => side.attack === null && side.cast === null)) return null;

  /*
   * The foes again once blessings have lapsed unrecast, by which ones (their
   * indexes in the order lost, which the fixed rounds make one order per set),
   * compiled the first time a trial loses them.
   */
  const lapses = new Map<string, FoeSide[]>([['', sides]]);
  const sidesWithout = (lost: readonly number[]): FoeSide[] => {
    const key = lost.join(',');
    const known = lapses.get(key);
    if (known !== undefined) return known;
    const gone = sumEffects(lost.flatMap((at) => input.recasts[at]?.effect ?? []));
    const less = gone === null ? input : lapsed(input.player, input.sheet, gone);
    const compiled = compile(less.player, less.sheet);
    lapses.set(key, compiled);
    return compiled;
  };

  const random = mulberry32(input.seed ?? 0x9e3779b9);
  const trials = Math.max(1, Math.trunc(input.trials));
  const roundCap = Math.max(1, Math.trunc(input.roundCap));
  const horizons = [...new Set(input.horizons ?? [])]
    .filter((rounds) => rounds > 0)
    .sort((a, b) => a - b);
  const reads = horizons.map(() => ({ standing: 0, won: 0, lost: [] as number[] }));
  const count = input.draw === undefined ? null : Math.max(1, Math.trunc(input.draw));
  let survived = 0;
  let roundsTotal = 0;
  let healsTotal = 0;
  let downTotal = 0;
  let manaTotal = 0;
  let worstRound = 0;
  const leftovers: number[] = [];

  /** Whether the pool is at or above a fraction of its maximum (`manaAtLeast`); 0 is no floor. */
  const clearsFloor = (pool: number, minMana: number): boolean =>
    minMana <= 0 ||
    (input.manaMax !== null && input.manaMax > 0 && pool / input.manaMax >= minMana);

  let ran = 0;
  const trial = (): void => {
    const met =
      count === null
        ? order
        : Array.from({ length: count }, () => Math.floor(random() * sides.length)).sort(
            (a, b) => position.get(a)! - position.get(b)!
          );
    const alive = met.map((index) => sides[index]!.hp);
    const states: MobState[] = met.map(() => freshMobState());
    const swinging = met.map((index) => foes[index]!.waits !== true);
    // The foes as the character now meets them, and the top of its bar: a lapse moves both.
    let facing = sides;
    let top = hpMax;
    const gone: number[] = [];
    let hp = input.hp;
    let mana = input.mana;
    let healing = false;
    let heals = 0;
    let regenCarry = 0;
    let held = 0;
    // Recasts paid for and not yet cast (`recastNow`).
    let recasting = 0;
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
      } else if (!healed() && !recastNow()) {
        const side = facing[met[target]!]!;
        swinging[target] = true;
        const dealt = strike(side);
        alive[target] = alive[target]! - dealt;
        if (alive[target]! <= 0 && side.death !== null) {
          const harm = side.death.high > 0 ? between(random, side.death.low, side.death.high) : 0;
          hp -= harm;
          lost += harm;
        }
      }

      // Every foe still standing and in the fight takes its round.
      let roundHarm = 0;
      for (const [slot, index] of met.entries()) {
        if (alive[slot]! <= 0 || !swinging[slot]) continue;
        const outcome = rollMobRound(random, facing[index]!.model, states[slot]!);
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
        hp = Math.min(top, hp + whole);
        regenCarry -= whole;
      }
      lapse();
      read(round, false);
    }
    read(Number.POSITIVE_INFINITY, !dead && alive.every((health) => health <= 0));

    roundsTotal += round;
    healsTotal += heals;
    downTotal += input.hp - Math.max(0, hp);
    if (input.mana !== null && mana !== null) manaTotal += input.mana - mana;
    if (!dead) {
      survived += 1;
      leftovers.push(Math.max(0, hp));
    }

    /** The character's turn spent on the heal `AutoHeal` would cast, if it would. */
    function healed(): boolean {
      const heal = input.heal;
      if (heal === null || mana === null) return false;
      const fraction = hp / top;
      const wants = fraction < heal.below || (heal.to > 0 && healing && fraction < heal.to);
      healing = wants;
      if (!wants) return false;
      if (!clearsFloor(mana, heal.minMana) || mana < heal.cost) return false;
      if (heal.chosenMends !== null && !mendsTheRound(heal.chosenMends, roundWorth())) return false;
      hp = Math.min(top, hp + between(random, heal.restores[0], heal.restores[1]));
      mana -= heal.cost;
      heals += 1;
      return true;
    }

    /**
     * The character's turn spent on a recast paid for. A blessing is cast with
     * `BreakCombat` (`Player.InitiateSpell`), so the round's swing goes with it.
     */
    function recastNow(): boolean {
      if (recasting === 0) return false;
      recasting -= 1;
      return true;
    }

    /**
     * What the round is worth to a heal, as `FightHeal` reads it: the mean
     * taken a round so far, else what the foes standing are expected to deal.
     */
    function roundWorth(): number {
      if (round > 1) return lost / (round - 1);
      let expected = 0;
      for (const [slot, index] of met.entries()) {
        if (alive[slot]! > 0 && swinging[slot]) expected += expectedHarm(facing[index]!.model);
      }
      return expected;
    }

    /**
     * This round's lapses: recast where the mana pays, else gone for the rest
     * of the fight, its effect off the character. Unknown mana pays for none.
     */
    function lapse(): void {
      for (const [at, recast] of input.recasts.entries()) {
        if (recast.round !== round) continue;
        const { cost } = recast;
        if (cost !== null && mana !== null && clearsFloor(mana, recast.minMana) && mana >= cost) {
          mana -= cost;
          recasting += 1;
          continue;
        }
        if (recast.effect === null) continue;
        gone.push(at);
        facing = sidesWithout(gone);
        top = Math.max(1, top - recast.effect.maxHp);
        hp = Math.min(hp, top);
      }
    }

    /** The character's blows at one foe this round. */
    function strike(side: FoeSide): number {
      if (side.cast !== null && mana !== null && mana >= side.cast.manaPerRound) {
        mana -= side.cast.manaPerRound;
        return side.cast.perRound;
      }
      if (side.attack !== null) {
        const swings = sampledCount(random, Math.min(MAX_SWINGS, side.attack.swings?.value ?? 1));
        let dealt = 0;
        for (let n = 0; n < swings; n += 1) {
          if (random() >= side.attack.lands.value) continue;
          // The blow's own range, as `prowess.swing` reads it, and a critical `rand(2 × max, 4 × max)`.
          const range = side.attack.range;
          if (range === null) {
            dealt += side.attack.damage.value;
            continue;
          }
          const critical = random() < (side.attack.crit?.value ?? 0);
          const rolled = critical
            ? between(random, 2 * range.high, 4 * range.high)
            : between(random, range.low, range.high);
          dealt += Math.max(0, rolled - side.resist);
        }
        return dealt;
      }
      // With the pool unread the spell is cast every round; there is no swing to fall back on.
      return side.cast !== null && mana === null ? side.cast.perRound : 0;
    }
  };

  return {
    get done() {
      return ran >= trials;
    },
    run(stop) {
      while (ran < trials) {
        trial();
        ran += 1;
        if (stop()) return;
      }
    },
    result() {
      const survives = survived / trials;
      leftovers.sort((a, b) => a - b);
      return {
        survives,
        level: survivalLevel(survives, input.levels),
        rounds: { value: roundsTotal / trials, from: 'measured' },
        hpLeft: leftovers.length === 0 ? null : leftovers[Math.floor(leftovers.length / 2)]!,
        heals: healsTotal / trials,
        lostMean: downTotal / trials,
        manaMean: input.mana === null ? null : manaTotal / trials,
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
  };
}

/**
 * The character once `gone` has lapsed: what it added taken off the monsters'
 * side and the formula sheet, and the `stat all` figures dropped, since they
 * carried it (`statedNow` drops them the same way once the buffs up move).
 */
function lapsed(
  player: MenacePlayer,
  sheet: ProwessSheet,
  gone: BlessingEffect
): { player: MenacePlayer; sheet: ProwessSheet } {
  const off = negated(gone);
  return {
    player: blessedPlayer(player, off),
    sheet: {
      ...sheet,
      stated: null,
      effects: sumEffects([...(sheet.effects ? [sheet.effects] : []), off])
    }
  };
}

/**
 * The row that harms the most, in expectation as the draw deals it
 * (`expectedHarm`): a name holding several rows is met as its worst.
 */
function worstModel(subject: MenaceSubject, player: MenacePlayer): MobModel {
  let worst: MobModel = { slots: [], casts: [], resist: 0 };
  let most = -1;
  for (const profile of subject.profiles ?? []) {
    const model = mobModel(subject, profile, player);
    const harm = expectedHarm(model);
    if (harm > most) {
      most = harm;
      worst = model;
    }
  }
  return worst;
}
