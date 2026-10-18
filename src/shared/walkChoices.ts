/**
 * The choices a route and a loop make on figures of their own, as settings
 * (todo 118): the barrier switches past the doors, how sure each must be, what
 * a route pays for a fight, a lair and another way, and when a lap gives up.
 * Each block's half lives here so the options file, the character file and the
 * settings screen read them through one function. The why is in
 * `mudengine-automation` › `parts/walking.md` and `mudengine-world` ›
 * `parts/routing.md`.
 */
import { bool, fraction, int, minutesMs } from './values';

/** The `automation.movement` keys todo 118 added. See `MovementConfig`. */
export interface MovementChoices {
  /** `disarm trap <dir>` before a trapped way where the odds make it worth it. On. */
  disarmTraps: boolean;
  /**
   * Failed disarms in a row whose chance at the sheet's Traps falls under this
   * mean the figure is likelier wrong, and the walk goes through the trap. A share.
   */
  disarmDoubt: number;
  /** `search <dir>` for a hidden exit the realm says a search finds, until it is found. On. */
  searchHidden: boolean;
  /** Pull the levers, or fetch the one elsewhere, that open a way on the route. On. */
  pullLevers: boolean;
  /** How many rounds of levers one exit is worth before the route stops. */
  leverTries: number;
  /** Refused sneaks in a row before the walk stops asking, until a new level or connection. */
  sneakGiveUp: number;
  /** How far under a lock's Picklocks number the character's may sit and still be tried. */
  pickMargin: number;
  /** The same for strength against a door to bash. Smaller: a failed bash costs health. */
  bashMargin: number;
  /** The fewest lights bought before a dark way, where the realm states no uses. */
  carryLights: number;
  /** Minutes a trip's route goes round a room this character ran from. 0 never does. */
  avoidRanFromMinutes: number;
  /** What one fight in a plan costs, in ordinary steps. */
  fightCost: number;
  /** What a lair expected to take half the health you have now costs to route through, in steps. */
  dangerCost: number;
  /** How many times over the plan's own steps are priced while Another way is looked for. */
  anotherWayPenalty: number;
  /** How much longer than the plan Another way may be, as a share of its steps. */
  anotherWayLonger: number;
  /**
   * A walk you send the character on takes the shorter way through a door
   * whose key a shop sells, buying it on the way (todo 02). On.
   */
  buyKeys: boolean;
  /** The most, in gold, those keys may cost together. */
  buyKeysMaxGold: number;
}

/** What the router prices a way by, handed in per request (`Traveller.prices`). */
export type RoutePrices = Pick<
  MovementChoices,
  'fightCost' | 'dangerCost' | 'anotherWayPenalty' | 'anotherWayLonger'
>;

/** Each at what the client did before it was a setting. */
export const DEFAULT_MOVEMENT_CHOICES: MovementChoices = {
  disarmTraps: true,
  disarmDoubt: 0.01,
  searchHidden: true,
  pullLevers: true,
  leverTries: 2,
  sneakGiveUp: 4,
  pickMargin: 20,
  bashMargin: 10,
  carryLights: 1,
  avoidRanFromMinutes: 15,
  fightCost: 30,
  dangerCost: 200,
  anotherWayPenalty: 3,
  anotherWayLonger: 0.5,
  buyKeys: true,
  buyKeysMaxGold: 500
};

/** The whole-number choices' bounds, one statement for the file and the settings screen. */
export const MOVEMENT_RANGES = {
  leverTries: [1, 10],
  sneakGiveUp: [1, 20],
  pickMargin: [0, 100],
  bashMargin: [0, 100],
  carryLights: [1, 10],
  avoidRanFromMinutes: [0, 1440],
  fightCost: [0, 1000],
  dangerCost: [0, 10_000],
  // 1 finds the plan again and offers nothing.
  anotherWayPenalty: [1, 20],
  buyKeysMaxGold: [0, 1_000_000]
} as const satisfies Partial<Record<keyof MovementChoices, readonly [number, number]>>;

/** The movement choices out of a raw block, each defaulted and bounded. */
export function movementChoices(raw: Record<string, unknown>): MovementChoices {
  const d = DEFAULT_MOVEMENT_CHOICES;
  const whole = (key: keyof typeof MOVEMENT_RANGES): number => {
    const [min, max] = MOVEMENT_RANGES[key];
    return int(raw[key], d[key], min, max);
  };
  return {
    disarmTraps: bool(raw['disarmTraps'], d.disarmTraps),
    disarmDoubt: fraction(raw['disarmDoubt'], d.disarmDoubt),
    searchHidden: bool(raw['searchHidden'], d.searchHidden),
    pullLevers: bool(raw['pullLevers'], d.pullLevers),
    leverTries: whole('leverTries'),
    sneakGiveUp: whole('sneakGiveUp'),
    pickMargin: whole('pickMargin'),
    bashMargin: whole('bashMargin'),
    carryLights: whole('carryLights'),
    avoidRanFromMinutes: whole('avoidRanFromMinutes'),
    fightCost: whole('fightCost'),
    dangerCost: whole('dangerCost'),
    anotherWayPenalty: whole('anotherWayPenalty'),
    anotherWayLonger: fraction(raw['anotherWayLonger'], d.anotherWayLonger),
    buyKeys: bool(raw['buyKeys'], d.buyKeys),
    buyKeysMaxGold: whole('buyKeysMaxGold')
  };
}

/** The `automation.walk` figures that say when a loop gives up, and when play asks. */
export interface LoopChoices {
  /**
   * Experience per hour below which a running loop is stopped: MegaMUD's
   * `MinExpRate` with `LogoffLowExp`, both 0 (off) in its defaults and off
   * here. A lap that no longer earns (an empty lair, a shut door, a monster
   * that does not die) keeps walking all night unattended. The rate is
   * measured over the lap since it started, resumed or came back online, and
   * judged only after `expRateGraceMinutes`, since a lap's first minutes are
   * the walk to the first lair. The client stops the loop and reports both
   * figures, and the tab reads `stopped`; MegaMUD logs off, which this client
   * does not do (`automation.safety.hangUp`). 0 never stops.
   */
  minExpPerHour: number;
  /** Failed legs in a row, none of them a fight, before the loop stops. */
  failedLegs: number;
  /** Minutes a lap runs before its exp rate is held against `minExpPerHour`. */
  expRateGraceMinutes: number;
  /** How much further away than when it stopped play may find the character before it asks. */
  resumeAskSteps: number;
}

export const DEFAULT_LOOP_CHOICES: LoopChoices = {
  minExpPerHour: 0,
  failedLegs: 3,
  expRateGraceMinutes: 15,
  resumeAskSteps: 30
};

export const LOOP_RANGES = {
  // Zero is off. Capped where no realm's experience curve reaches in an hour.
  minExpPerHour: [0, 100_000_000],
  failedLegs: [1, 20],
  expRateGraceMinutes: [0, 240],
  resumeAskSteps: [0, 1000]
} as const satisfies Record<keyof LoopChoices, readonly [number, number]>;

/** The loop choices out of a raw `walk:` block, each defaulted and bounded. */
export function loopChoices(raw: Record<string, unknown>): LoopChoices {
  const d = DEFAULT_LOOP_CHOICES;
  const whole = (key: keyof LoopChoices): number => {
    const [min, max] = LOOP_RANGES[key];
    return int(raw[key], d[key], min, max);
  };
  return {
    minExpPerHour: whole('minExpPerHour'),
    failedLegs: whole('failedLegs'),
    expRateGraceMinutes: whole('expRateGraceMinutes'),
    resumeAskSteps: whole('resumeAskSteps')
  };
}

/** A request's prices, or the shipped ones where the asker states none (a probe, a draft, a test). */
export function routePrices(given: RoutePrices | undefined): RoutePrices {
  return given ?? DEFAULT_MOVEMENT_CHOICES;
}

/** The four prices alone, out of a whole `movement` block, for a request to carry. */
export function routePricesOf(movement: RoutePrices): RoutePrices {
  const { fightCost, dangerCost, anotherWayPenalty, anotherWayLonger } = movement;
  return { fightCost, dangerCost, anotherWayPenalty, anotherWayLonger };
}

/** How long a lap runs before its exp rate is judged, as a clock reads it. */
export function expRateGraceMs(walk: Pick<LoopChoices, 'expRateGraceMinutes'>): number {
  return minutesMs(walk.expRateGraceMinutes);
}
