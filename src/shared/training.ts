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
