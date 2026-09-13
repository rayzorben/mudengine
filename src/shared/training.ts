/**
 * Spending character points: what a point costs and which to buy (todo 10,
 * 2026-09-12). The cost is `StatField.Validate`'s own loop, transcribed —
 * the tenth point above the *race* base costs one more than the ninth — and
 * the plan buys the cheapest wanted point until nothing wanted is affordable.
 * See `mudengine-automation` § *Character points are spent on the stat
 * screen, under a switch*.
 */

/** The six the stat screen sells, in the order its fields run. */
export const TRAINED_ATTRIBUTES = [
  'strength',
  'intellect',
  'willpower',
  'agility',
  'health',
  'charm'
] as const;
export type TrainedAttribute = (typeof TRAINED_ATTRIBUTES)[number];

/** `Races.mSTR`/`xSTR`: the race's base, which the price counts from, and its ceiling. */
export interface StatLimits {
  base: number;
  max: number;
}

export interface Purchase {
  attribute: TrainedAttribute;
  from: number;
  to: number;
  cost: number;
}

export interface TrainingPlan {
  /** Where each stat ends up; equal to the current figure where nothing is bought. */
  targets: Record<TrainedAttribute, number>;
  purchases: Purchase[];
  spent: number;
  left: number;
  /** Wanted above the current figure, and the next point costs more than what is left. */
  unaffordable: Array<{ attribute: TrainedAttribute; nextCost: number }>;
  /** Wanted above the race's ceiling; the ceiling is what was aimed at. */
  capped: TrainedAttribute[];
}

/**
 * What the point taking a stat from `at` to `at + 1` costs:
 * `floor((i − Base − 1) / 10) + 1` for `i = at + 1`, which is one point for
 * each of the first ten above the base, two for the next ten, and so on.
 */
export function nextPointCost(base: number, at: number): number {
  return Math.floor((at - base) / 10) + 1;
}

/** The whole rise from `from` to `to`, as the server sums it. */
export function raiseCost(base: number, from: number, to: number): number {
  let total = 0;
  for (let at = from; at < to; at += 1) total += nextPointCost(base, at);
  return total;
}

export interface TrainingInput {
  current: Record<TrainedAttribute, number>;
  /** The figures wanted; 0 or under the current figure means *leave it*. */
  wanted: Record<TrainedAttribute, number>;
  limits: Record<TrainedAttribute, StatLimits>;
  cp: number;
}

/**
 * Cheapest wanted point first, ties in field order, until every wanted stat
 * is either reached or priced beyond what is left. Cheapest first because it
 * is the most points for the CP, and a stat left short today is one point
 * cheaper the next time this runs than the dearer stat would have been.
 */
export function planTraining(input: TrainingInput): TrainingPlan {
  const targets = { ...input.current };
  const capped: TrainedAttribute[] = [];
  const goal: Partial<Record<TrainedAttribute, number>> = {};
  for (const attribute of TRAINED_ATTRIBUTES) {
    const wanted = input.wanted[attribute];
    const { max } = input.limits[attribute];
    if (wanted > max) capped.push(attribute);
    const aim = Math.min(wanted, max);
    if (aim > input.current[attribute]) goal[attribute] = aim;
  }

  let left = input.cp;
  const unaffordable: TrainingPlan['unaffordable'] = [];
  for (;;) {
    let pick: { attribute: TrainedAttribute; cost: number } | null = null;
    for (const attribute of TRAINED_ATTRIBUTES) {
      const aim = goal[attribute];
      if (aim === undefined || targets[attribute] >= aim) continue;
      const cost = nextPointCost(input.limits[attribute].base, targets[attribute]);
      if (cost > left) {
        unaffordable.push({ attribute, nextCost: cost });
        delete goal[attribute];
        continue;
      }
      if (pick === null || cost < pick.cost) pick = { attribute, cost };
    }
    if (pick === null) break;
    targets[pick.attribute] += 1;
    left -= pick.cost;
  }

  // Cheapest first, as the choice was made; ties keep field order (the sort is stable).
  unaffordable.sort((a, b) => a.nextCost - b.nextCost);
  const purchases: Purchase[] = [];
  for (const attribute of TRAINED_ATTRIBUTES) {
    const from = input.current[attribute];
    const to = targets[attribute];
    if (to === from) continue;
    purchases.push({
      attribute,
      from,
      to,
      cost: raiseCost(input.limits[attribute].base, from, to)
    });
  }
  return { targets, purchases, spent: input.cp - left, left, unaffordable, capped };
}

/**
 * Whether anything wanted is above what the sheet says, where the sheet says.
 * The reviewer's rule: a switch left on with every figure at or under the
 * current one does nothing, and says so once.
 */
export function wantsMore(
  wanted: Record<TrainedAttribute, number>,
  current: Partial<Record<TrainedAttribute, number | null>>
): boolean {
  return TRAINED_ATTRIBUTES.some((attribute) => {
    const now = current[attribute];
    return now !== null && now !== undefined && wanted[attribute] > now;
  });
}

/* -------------------------------------------------------------- the trainer */

/**
 * A place that will take a level, as the realm states it.
 *
 * Only what choosing needs: the room it is in is the caller's, because a shop
 * is a property of a room and the caller is the one holding the index.
 */
export interface TrainerRow {
  /** The shop's own row number, so a choice can be recorded as a fact. */
  id: number;
  name: string;
  /** `Shops.MinLVL`; absent is no floor. */
  minLevel?: number;
  /** `Shops.MaxLVL`; absent is no ceiling. */
  maxLevel?: number;
  /** `Shops.ClassRest`; absent is anybody. */
  classOnly?: number;
  /** `Shops.Markup%`, the percentage added to the base price. Absent is none. */
  markup?: number;
}

/**
 * Whether a trainer takes a character of this level and class.
 *
 * **The off-by-one is the server's and it is load-bearing.**
 * `TrainCommand.cs:33` refuses below `MinLVL - 1` and at or above `MaxLVL`,
 * so a level 20 character *may* train at a 21–50 trainer — training is what
 * makes it 21 — and a level 50 character may **not**, because 50 is the
 * ceiling rather than the last level served. A client using the band as
 * written walks to the wrong room at every boundary, in both directions.
 *
 * Class is one id or nothing; `unknown` class is not permission, so a
 * restricted trainer refuses a character whose class the client has not read.
 */
export function trainsLevel(trainer: TrainerRow, level: number, classId: number | null): boolean {
  if (trainer.minLevel !== undefined && level < trainer.minLevel - 1) return false;
  if (trainer.maxLevel !== undefined && level >= trainer.maxLevel) return false;
  if (trainer.classOnly !== undefined && trainer.classOnly !== classId) return false;
  return true;
}

/**
 * What one level costs here, in copper.
 *
 * `TrainCommand.cs:92`, transcribed including its integer division — the
 * markup is applied *before* dividing, so computing it any other way
 * disagrees with the server at the rounding and the client quotes a figure
 * the counter will not honour.
 *
 * Measured against the wire: level 30 at `Training Area` (markup 6,000) was
 * **88,450** copper, which is `29 × 50 × 6100 / 100`.
 */
export const BASE_TRAINING_COPPER = 50;

export function trainingCost(level: number, markup: number | undefined): number {
  const base = (level - 1) * BASE_TRAINING_COPPER;
  return Math.trunc((base * (100 + (markup ?? 0))) / 100);
}

/**
 * The trainers that will take this character, cheapest first.
 *
 * **Cost leads, and it is not close.** The bands overlap heavily — 21–50,
 * 31–52, 41–54, 51–75 — so a level 52 character matches several, and the
 * markups across them span a factor of eight: `Hydra Trainer` (51–75) charges
 * 9,999% and quotes 257,524 copper at level 52, where `Sixty Seven` (1–67)
 * charges 1,200% and quotes 33,150. Reach buys at most one walk saved, once;
 * the markup is paid at **every** level. Reach is the tiebreak, so that
 * between two equally priced rooms the one serving the next several levels
 * wins and the walk is not repeated.
 *
 * **The band filter is what stops the ladder stalling**, not the order.
 * Walking into the *first* match refused at exactly 52 and again at 54 —
 * bands whose ceiling the character had just reached — and `trainsLevel`
 * excludes those outright, whatever the sort does with the rest.
 *
 * The whole list rather than one answer: the player picks (the settings
 * screen offers exactly these), and a client that has to fall back needs the
 * next one down.
 */
export function trainersFor(
  trainers: readonly TrainerRow[],
  level: number,
  classId: number | null
): TrainerRow[] {
  return trainers
    .filter((trainer) => trainsLevel(trainer, level, classId))
    .sort(
      (a, b) =>
        trainingCost(level, a.markup) - trainingCost(level, b.markup) ||
        (b.maxLevel ?? Number.MAX_SAFE_INTEGER) - (a.maxLevel ?? Number.MAX_SAFE_INTEGER) ||
        a.id - b.id
    );
}
