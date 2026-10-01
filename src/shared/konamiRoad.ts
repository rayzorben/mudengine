/**
 * The road ahead (todo 68): the next goals, projected from what the character
 * holds now. Hunt the best ground until the next level, train it once the
 * copper is carried, buy the cheapest upgrade the level and the purse allow,
 * and, while copper is short of what comes next, hunt where the monsters carry
 * enough of it. The same order the planner's questions offer, played forward.
 *
 * Projected here, never asked of the provider: the provider is paid per call
 * (todo 66), and twenty future goals would be twenty calls. It is asked, as
 * before, once each goal is reached; the road is what it is expected to say,
 * and the player's way to say no early. A goal the player declines, or marks
 * bad, is left off the road and never offered to the provider again.
 *
 * Every rate is today's: a ground's exp and copper an hour as the Hunting
 * grounds measure it now. The road ends where the experience table does, and
 * where a level has no trainer the realm states.
 */
import type { KonamiGoal } from './konami';
import type { KonamiBrief, SlotUpgrade } from './konamiBrief';
import { goalKey, itemKey } from './konamiLessons';
import { slotGives } from './konamiPurse';

/** A ground the road may hunt: what it yields an hour at today's figures. */
export interface RoadGround {
  key: string;
  name: string;
  expPerHour: number;
  /** Null where its monsters' coin is not known: never chosen for copper, never counted as none. */
  copperPerHour: number | null;
}

/** What the realm says about the levels ahead, gathered when the planner builds a brief. */
export interface RoadFacts {
  /** The experience each level needs, ascending, as far as the table goes. */
  thresholds: ReadonlyArray<{ level: number; exp: number }>;
  /** What training from each level costs at the trainer that takes it. */
  trainCosts: ReadonlyArray<{ level: number; copper: number }>;
  /** Best first, as the Hunting grounds rank them; only the ones offered as safe. */
  grounds: readonly RoadGround[];
  /** Per slot, what is worn and what is sold that is better, up to the road's last level. */
  gear: readonly SlotUpgrade[];
}

export interface RoadInput extends RoadFacts {
  level: number;
  exp: number;
  /** Copper carried and banked; the road spends both. */
  copper: number;
  /** Goal keys the player declined or marked bad. */
  declined: ReadonlySet<string>;
  /** The most steps projected. */
  steps: number;
}

/** One goal on the road, and when it starts, in hours from now. */
export type RoadStep =
  | {
      kind: 'hunt';
      goal: Extract<KonamiGoal, { kind: 'hunt' }>;
      /** Hunted until this level is ready, or until this much copper is held. */
      until: { level: number } | { copper: number };
      hours: number;
      exp: number;
      /** Null where the ground's copper rate is not known. */
      copper: number | null;
      at: number;
      level: number;
    }
  | { kind: 'train'; level: number; copper: number; at: number }
  | {
      kind: 'buy';
      goal: Extract<KonamiGoal, { kind: 'buy' }>;
      level: number;
      at: number;
    };

/**
 * Why the road stops where it does. `unread`: nothing to project from yet,
 * no brief built or the purse, the level or the experience not read.
 */
export type RoadEnd = 'steps' | 'table' | 'trainer' | 'grounds' | 'unread';

export interface Road {
  steps: RoadStep[];
  end: RoadEnd;
}

/** The ground the hunt keeps earning the copper wanted on: the most exp among those paying it. */
function groundFor(grounds: readonly RoadGround[], copperPerHour: number): RoadGround | null {
  const known = grounds.filter(
    (ground): ground is RoadGround & { copperPerHour: number } => ground.copperPerHour !== null
  );
  const paying = known.find((ground) => ground.copperPerHour >= copperPerHour);
  if (paying !== undefined) return paying;
  // None pays it: the one known to pay most.
  return known.reduce<(typeof known)[number] | null>(
    (best, ground) => (best === null || ground.copperPerHour > best.copperPerHour ? ground : best),
    null
  );
}

const huntGoal = (ground: RoadGround): Extract<KonamiGoal, { kind: 'hunt' }> => ({
  kind: 'hunt',
  key: ground.key,
  name: ground.name
});

/** Projects the road (pure). */
export function projectRoad(input: RoadInput): Road {
  const grounds = input.grounds.filter(
    (ground) => ground.expPerHour > 0 && !input.declined.has(goalKey(huntGoal(ground)))
  );
  const steps: RoadStep[] = [];
  const threshold = (level: number): number | null =>
    input.thresholds.find((row) => row.level === level)?.exp ?? null;
  const trainCost = (level: number): number | null =>
    input.trainCosts.find((row) => row.level === level)?.copper ?? null;
  // What each slot gives now, raised as the road buys.
  const worn = new Map(
    input.gear.map((slot) => [slot.slot, slotGives(slot.ranking, slot.wornFigure) ?? 0])
  );
  const offers = input.gear.flatMap((slot) =>
    slot.offers.flatMap((offer) => {
      if (offer.copper === null) return [];
      const goal: Extract<KonamiGoal, { kind: 'buy' }> = {
        kind: 'buy',
        item: offer.item,
        name: offer.name,
        slot: slot.slot,
        shop: offer.shop,
        at: offer.at,
        copper: offer.copper
      };
      if (input.declined.has(goalKey(goal))) return [];
      const figure = slot.ranking === 'weapon' ? offer.figure : offer.ac;
      return [{ goal, minLevel: offer.minLevel ?? 0, gives: slotGives(slot.ranking, figure) ?? 0 }];
    })
  );
  const better = (offer: (typeof offers)[number]): boolean =>
    offer.gives > (worn.get(offer.goal.slot) ?? 0);

  let { level, exp, copper } = input;
  let hours = 0;
  const hunt = (
    ground: RoadGround,
    until: { level: number } | { copper: number },
    need: number
  ) => {
    const rate = ground.copperPerHour;
    const taken = 'level' in until ? need / ground.expPerHour : need / Math.max(rate ?? 0, 1);
    const gained = { exp: ground.expPerHour * taken, copper: rate === null ? null : rate * taken };
    steps.push({
      kind: 'hunt',
      goal: huntGoal(ground),
      until,
      hours: taken,
      exp: Math.round(gained.exp),
      copper: gained.copper === null ? null : Math.round(gained.copper),
      at: hours,
      level
    });
    hours += taken;
    // Landed on the mark, so rounding never leaves a sliver of a second hunt to it.
    exp = 'level' in until ? Math.max(exp + gained.exp, need + exp) : exp + gained.exp;
    copper =
      'copper' in until
        ? Math.max(until.copper, copper + (gained.copper ?? 0))
        : copper + (gained.copper ?? 0);
  };

  while (steps.length < input.steps) {
    const next = threshold(level + 1);
    if (next === null) return { steps, end: 'table' };
    const cost = trainCost(level);
    if (cost === null) return { steps, end: 'trainer' };
    if (exp >= next) {
      if (copper >= cost) {
        steps.push({ kind: 'train', level: level + 1, copper: cost, at: hours });
        copper -= cost;
        level += 1;
        continue;
      }
      // Nothing but copper is wanted: the ground paying most of it.
      const ground = groundFor(grounds, Number.POSITIVE_INFINITY);
      if (ground === null || (ground.copperPerHour ?? 0) <= 0) return { steps, end: 'grounds' };
      hunt(ground, { copper: cost }, cost - copper);
      continue;
    }
    // An upgrade wearable now that the purse covers with training still paid for: cheapest first.
    const buy = offers
      .filter((offer) => offer.minLevel <= level && better(offer))
      .filter((offer) => offer.goal.copper <= copper - cost)
      .sort((a, b) => a.goal.copper - b.goal.copper)[0];
    if (buy !== undefined) {
      steps.push({ kind: 'buy', goal: buy.goal, level, at: hours });
      copper -= buy.goal.copper;
      worn.set(buy.goal.slot, buy.gives);
      continue;
    }
    // Hunt to the level, earning on the way what training it and the next upgrade will cost.
    const wanted = offers
      .filter((offer) => offer.minLevel <= level + 1 && better(offer))
      .sort((a, b) => a.goal.copper - b.goal.copper)[0];
    const need = cost + (wanted?.goal.copper ?? 0) - copper;
    const fastest = grounds[0];
    if (fastest === undefined) return { steps, end: 'grounds' };
    const toLevel = (next - exp) / fastest.expPerHour;
    const ground = groundFor(grounds, need > 0 ? need / toLevel : 0) ?? fastest;
    hunt(ground, { level: level + 1 }, next - exp);
  }
  return { steps, end: 'steps' };
}

/**
 * The brief without what the player said no to: the declined grounds and items
 * are never offered to the provider, so it chooses among what is left.
 */
export function withoutDeclined(brief: KonamiBrief, declined: ReadonlySet<string>): KonamiBrief {
  if (declined.size === 0) return brief;
  return {
    ...brief,
    hunting: {
      ...brief.hunting,
      spots: brief.hunting.spots.filter(
        (spot) => !declined.has(goalKey({ kind: 'hunt', key: spot.key, name: spot.name }))
      )
    },
    gear: brief.gear.map((slot) => ({
      ...slot,
      offers: slot.offers.filter((offer) => !declined.has(itemKey(offer.item)))
    }))
  };
}

/** A goal the player declined on the road, or marked bad (sent as a lesson). */
export interface RoadMark {
  key: string;
  goal: KonamiGoal;
  bad: boolean;
  at: number;
  level: number | null;
}

/** The road as the Konami card shows it. */
export interface KonamiRoadView {
  steps: RoadStep[];
  end: RoadEnd;
  /** Newest first. */
  marks: RoadMark[];
}
