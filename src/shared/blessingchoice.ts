/**
 * Which self blessings pay for the fight being hunted, within the mana the
 * character can spare after its heals (`automation.spells.autoChooseBlessings`).
 *
 * Each candidate is weighed by running the fight with it up against the
 * fight without (`run`, the session's simulator, the same seed both ways).
 * Below `safeAbove` survival the survival gained decides; otherwise the exp
 * rate, the spot's cycle rebuilt as `estimateSpot` builds it: combat time by
 * the change in rounds, rest by the change in health lost, the upkeep as
 * meditation time, and never faster than the respawn clock. A safe fight with
 * no spot (a lair in the room, nothing hunted) has no cycle, so the share of
 * the bar a fight costs decides, which is what resting pays back. Chosen greedily
 * by gain per mana an hour, each step weighed against the set so far. Mana
 * an hour is income (regeneration, and meditation in the cycle's wait) less
 * the heals the fight still costs; an unknown income is a refusal, never a
 * figure. See mudengine-automation › *Recovery*.
 *
 * Dependency-free, like everything in `shared/`.
 */
import type { BlessingConfig } from './blessings';
import { exclusive, type BlessingEffect } from './blessingeffects';
import type { WorldSpell } from './world';

/** Why a blessing, or the whole choice, came to nothing. */
export const BLESSING_REFUSALS = [
  /** Nothing is hunted and no lair is here, and nothing was chosen before. */
  'no-fight',
  /** The fight cannot be run for this character (an unread sheet, an unpriced foe). */
  'unrun',
  /** The fight is still being run. */
  'pending',
  /** Mana regeneration is not known: no budget can be kept. */
  'unknown-mana',
  /** No spell in the book weighs anything the fight reads. */
  'no-candidates',
  /** The cast's odds cannot be worked out, so neither can its upkeep. */
  'unknown-cost',
  /** Neither a measured duration nor the realm's states how long it stays up. */
  'unknown-duration',
  /** It takes off a blessing already chosen, or that one takes it off. */
  'exclusive',
  /** Up, the fight goes no better by enough to pay for it. */
  'no-gain',
  /** Its upkeep would leave the heals short of mana. */
  'over-budget'
] as const;

export type BlessingRefusal = (typeof BLESSING_REFUSALS)[number];

/** A self blessing the character could keep up. */
export interface BlessingCandidate {
  /** The whole spell name, as a row casts it. */
  name: string;
  spell: WorldSpell;
  effect: BlessingEffect;
  /** Mana a cast is expected to cost, failures included (`castOdds`); null unknown. */
  cost: number | null;
  /** How long it stays up: measured on the wire, else the realm's `Dur` in ticks. */
  duration: { seconds: number; from: 'measured' | 'realm' } | null;
  /** The player's own row for it, where the hand list has one. */
  row: BlessingConfig | null;
}

/** One run of the fight: what the simulator measured over its trials. */
export interface FightRun {
  survives: number;
  /** Rounds a fight took, the mean. */
  rounds: number;
  /** Health down when a fight ended, the mean (`Survival.lostMean`). */
  lostMean: number;
  /** Heals cast a fight, the mean. */
  heals: number;
}

/** The hunted spot's cycle, from its estimate (`SpotEstimate`). */
export interface SpotCycle {
  expPerHour: number;
  cycleSeconds: number;
  combatSeconds: number;
  restSeconds: number;
  /** Standing for the respawn; over 0 means the clock bounds the cycle. */
  waitSeconds: number;
  /** Fights a cycle: the rooms the lap stops in. */
  fights: number;
}

/** Mana coming back. */
export interface ManaIncome {
  /** Standing, an hour. */
  perHour: number;
  /** Meditating, a second. */
  meditatingPerSecond: number;
}

export interface BlessingChoiceInput {
  candidates: readonly BlessingCandidate[];
  /**
   * The fight with these blessings up and nothing else (none: the bare
   * character), or `pending` while it is being run, or null where it cannot be.
   */
  run(set: readonly BlessingCandidate[]): FightRun | 'pending' | null;
  /** The hunted spot's cycle; null weighs survival alone. */
  cycle: SpotCycle | null;
  income: ManaIncome | null;
  /** What one cast of the heal the fight is run with costs; null where none is cast. */
  healCost: number | null;
  /** The share of fights survived over which the exp rate decides. */
  safeAbove: number;
  /** The least gain worth an upkeep: survival or the bar in shares, exp as a share of the bare rate. */
  minGain: number;
  manaMax: number | null;
  /** The bare character's maximum health, which a fight's cost is a share of; null unread. */
  hpMax: number | null;
  /** Heal casts a derived row's mana floor keeps affordable after the blessing. */
  healReserve: number;
  /** The realm's round, seconds: the server's over its speed (`atSpeed`), as the income's ticks are. */
  roundSeconds: number;
}

export interface BlessingPick {
  candidate: BlessingCandidate;
  /** What it added when chosen: survival in shares, exp an hour, or a share of the bar kept a fight. */
  gain: number;
  /** Mana an hour it costs to keep up. */
  upkeepPerHour: number;
  /** The row `Blessings` casts it by. */
  row: BlessingConfig;
}

export type BlessingChoice =
  | { kind: 'refused'; why: BlessingRefusal }
  | {
      kind: 'chosen';
      /** What decided. */
      by: BlessingMeasure;
      picks: BlessingPick[];
      passed: Array<{ name: string; why: BlessingRefusal }>;
      /** Mana an hour left over once the picks and the heals are paid. */
      spare: number;
    };

/**
 * What a blessing is weighed by: survival where the fight is not safe, the
 * exp rate where it is and the spot's cycle is known, else the health a fight
 * costs.
 */
export type BlessingMeasure = 'survival' | 'exp' | 'health';

interface Weighed {
  candidate: BlessingCandidate;
  upkeep: number;
}

export function chooseBlessings(input: BlessingChoiceInput): BlessingChoice {
  const bare = input.run([]);
  if (bare === 'pending') return { kind: 'refused', why: 'pending' };
  if (bare === null) return { kind: 'refused', why: 'unrun' };
  if (input.income === null) return { kind: 'refused', why: 'unknown-mana' };
  if (input.candidates.length === 0) return { kind: 'refused', why: 'no-candidates' };
  const income = input.income;

  const passed = new Map<string, BlessingRefusal>();
  const eligible: Weighed[] = [];
  for (const candidate of input.candidates) {
    if (candidate.cost === null) passed.set(candidate.name, 'unknown-cost');
    else if (candidate.duration === null || candidate.duration.seconds <= 0)
      passed.set(candidate.name, 'unknown-duration');
    else
      eligible.push({
        candidate,
        upkeep: (candidate.cost * 3600) / candidate.duration.seconds
      });
  }

  const cycle = input.cycle;
  const by: BlessingMeasure =
    bare.survives <= input.safeAbove ? 'survival' : cycle !== null ? 'exp' : 'health';
  const value = (run: FightRun, upkeep: number): number | null => {
    switch (by) {
      case 'survival':
        return run.survives;
      case 'exp':
        return expPerHour(cycle!, bare, run, upkeep, income);
      case 'health':
        return input.hpMax !== null && input.hpMax > 0 ? -run.lostMean / input.hpMax : null;
      default: {
        const never: never = by;
        return never;
      }
    }
  };
  const spareOf = (run: FightRun, upkeep: number): number =>
    income.perHour + meditatedInWait(cycle, income) - healsPerHour(input, run) - upkeep;
  const threshold = by === 'exp' ? input.minGain * cycle!.expPerHour : input.minGain;

  const picks: BlessingPick[] = [];
  let upkeep = 0;
  const first = value(bare, 0);
  // The bare fight's own measure unknown: nothing can be weighed against it.
  if (first === null) return { kind: 'refused', why: 'unrun' };
  let current = first;
  let spare = spareOf(bare, 0);
  for (;;) {
    let best: { weighed: Weighed; gain: number; worth: number; spare: number } | null = null;
    let pending = false;
    for (const weighed of eligible) {
      const { candidate } = weighed;
      if (picks.some((pick) => pick.candidate === candidate)) continue;
      if (picks.some((pick) => exclusive(pick.candidate.spell, candidate.spell))) {
        passed.set(candidate.name, 'exclusive');
        continue;
      }
      const run = input.run([...picks.map((pick) => pick.candidate), candidate]);
      if (run === 'pending') {
        pending = true;
        continue;
      }
      if (run === null) {
        passed.set(candidate.name, 'unrun');
        continue;
      }
      const total = upkeep + weighed.upkeep;
      const after = value(run, total);
      const gain = after === null ? Number.NEGATIVE_INFINITY : after - current;
      if (gain < threshold) {
        passed.set(candidate.name, 'no-gain');
        continue;
      }
      const left = spareOf(run, total);
      if (left < 0) {
        passed.set(candidate.name, 'over-budget');
        continue;
      }
      const worth = weighed.upkeep > 0 ? gain / weighed.upkeep : Number.POSITIVE_INFINITY;
      if (best === null || worth > best.worth) best = { weighed, gain, worth, spare: left };
    }
    if (pending) return { kind: 'refused', why: 'pending' };
    if (best === null) break;
    const { candidate } = best.weighed;
    passed.delete(candidate.name);
    picks.push({
      candidate,
      gain: best.gain,
      upkeepPerHour: best.weighed.upkeep,
      row: rowFor(candidate, input)
    });
    upkeep += best.weighed.upkeep;
    current += best.gain;
    spare = best.spare;
  }
  return {
    kind: 'chosen',
    by,
    picks,
    passed: [...passed].map(([name, why]) => ({ name, why })),
    spare
  };
}

/**
 * The exp rate with a set up: the spot's cycle with its combat scaled by the
 * rounds, its rest by the health lost, the upkeep meditated back, and the
 * respawn clock as the floor. Null where the upkeep outruns meditation.
 */
function expPerHour(
  cycle: SpotCycle,
  bare: FightRun,
  run: FightRun,
  upkeepPerHour: number,
  income: ManaIncome
): number | null {
  const combat =
    bare.rounds > 0 ? (cycle.combatSeconds * run.rounds) / bare.rounds : cycle.combatSeconds;
  const rest =
    bare.lostMean > 0 ? (cycle.restSeconds * run.lostMean) / bare.lostMean : cycle.restSeconds;
  const work =
    cycle.cycleSeconds -
    cycle.waitSeconds -
    cycle.combatSeconds -
    cycle.restSeconds +
    combat +
    rest;
  // The share of every second spent meditating the upkeep back.
  const share =
    upkeepPerHour <= 0
      ? 0
      : income.meditatingPerSecond > 0
        ? upkeepPerHour / 3600 / income.meditatingPerSecond
        : 1;
  if (share >= 1) return null;
  const floor = cycle.waitSeconds > 0 ? cycle.cycleSeconds : 0;
  const seconds = Math.max(work / (1 - share), floor);
  return seconds > 0 ? (cycle.expPerHour * cycle.cycleSeconds) / seconds : null;
}

/** Mana an hour meditated back while standing for the respawn. */
function meditatedInWait(cycle: SpotCycle | null, income: ManaIncome): number {
  if (cycle === null || cycle.cycleSeconds <= 0) return 0;
  return (cycle.waitSeconds * income.meditatingPerSecond * 3600) / cycle.cycleSeconds;
}

/**
 * Mana an hour the heals take: heals a fight, fights an hour, a cast's cost.
 * Without a cycle the fights are back to back, the most a fight can cost.
 */
function healsPerHour(input: BlessingChoiceInput, run: FightRun): number {
  if (input.healCost === null || run.heals <= 0) return 0;
  const fightsPerHour =
    input.cycle !== null && input.cycle.cycleSeconds > 0
      ? (input.cycle.fights * 3600) / input.cycle.cycleSeconds
      : 3600 / Math.max(input.roundSeconds, run.rounds * input.roundSeconds);
  return run.heals * fightsPerHour * input.healCost;
}

/**
 * The row a chosen blessing is cast by: the player's own where the hand list
 * has one, its mana floor raised to keep `healReserve` heals affordable after
 * the cast; otherwise a self row recast mid-fight, as a self row is by default.
 */
function rowFor(candidate: BlessingCandidate, input: BlessingChoiceInput): BlessingConfig {
  const max = input.manaMax;
  const reserve = (candidate.cost ?? 0) + input.healReserve * (input.healCost ?? 0);
  const floor = max === null || max <= 0 ? 0 : Math.min(1, reserve / max);
  const own = candidate.row;
  if (own !== null) return { ...own, minMana: Math.max(own.minMana, floor) };
  return {
    spell: candidate.name,
    target: 'self',
    minMana: floor,
    prioritizeOverHeal: false,
    inCombat: true
  };
}
