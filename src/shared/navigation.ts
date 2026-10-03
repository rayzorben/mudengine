/**
 * A plan to get somewhere, made whole before the first step: every key the
 * way wants and where each comes from, in the order they can be had, the
 * fights it takes, and the walk between. Or the reasons there is none, each
 * named. Made by the one navigation engine (`main/world/navigation/plan.ts`);
 * `mudengine-world` › *There is one navigation engine*.
 */
import type { UiLookup } from './i18n';
import type { FightOdds, PlanFight, RoomId, Route } from './world';

/** What the plan asks of the session about this character, beyond the route. */
export interface NavigationOracle {
  /** The fight with this monster where the realm puts it. */
  fight(monster: string, room: RoomId): FightOdds;
  /** Whether the purse covers the item at the counter in this room; null where nobody has said. */
  affords(item: number, room: RoomId): boolean | null;
}

export interface PlannedItem {
  id: number;
  name: string;
}

export type PlanStep =
  | { kind: 'walk'; route: Route }
  | { kind: 'buy'; item: PlannedItem; room: RoomId }
  | { kind: 'ask'; item: PlannedItem; room: RoomId; say: string }
  /** Kill `monster` here for the item; `summon` brings it first. `odds` is the worse of the two. */
  | {
      kind: 'kill';
      item: PlannedItem;
      monster: string;
      room: RoomId;
      roomName: string;
      summon?: { say: string } | { by: string };
      odds: FightOdds;
    }
  /** Kill what stands in this room, which a way through it wants empty (`nomonsters`). */
  | ClearStep;

export interface ClearStep {
  kind: 'clear';
  room: RoomId;
  name: string;
  monsters: string[];
  /** The worst of the fights with them. */
  odds: FightOdds;
}

/**
 * The worse of two fights: the lower share walked out of, and a fight not
 * worked out yet worse than any, since unknown is the unsafe case.
 */
export function worseOdds(a: FightOdds, b: FightOdds): FightOdds {
  return shareOf(b) < shareOf(a) ? b : a;
}

/** A fight's share walked out of for ranking: unread is none, an unweighable win is all. */
export function shareOf(odds: FightOdds): number {
  return odds.kind === 'unread' ? -1 : (odds.survives ?? 1);
}

/** The fights a plan takes, in order: each key's dropper and each room it clears. */
export function planFights(plan: Plan): PlanFight[] {
  if (plan.kind === 'refused') return [];
  return plan.steps.flatMap((step): PlanFight[] => {
    if (step.kind === 'kill') {
      const summoner = step.summon !== undefined && 'by' in step.summon ? [step.summon.by] : [];
      const monsters = [...summoner, step.monster];
      return [{ monsters, roomName: step.roomName, item: step.item.name, odds: step.odds }];
    }
    if (step.kind === 'clear') {
      return [{ monsters: step.monsters, roomName: step.name, item: null, odds: step.odds }];
    }
    return [];
  });
}

/** One fight on a planned way, in words, with the odds (`Route.fights`). */
export function fightWords(fight: PlanFight, t: UiLookup): string {
  const { odds } = fight;
  const monster = fight.monsters.join(', ');
  if (odds.kind === 'unread') return t('navigation.oddsUnread', { monster });
  if (odds.survives === null) return t('navigation.fightUnweighed', { monster });
  const survives = `${Math.round(odds.survives * 100)}%`;
  return fight.item === null
    ? t('navigation.fightInTheWay', { monster, survives, roomName: fight.roomName })
    : t('navigation.fightForItem', {
        item: fight.item,
        monster,
        survives,
        roomName: fight.roomName
      });
}

/** What a room to clear asks, in words. */
export function clearWords(step: ClearStep, t: UiLookup): string {
  return t('navigation.clearFirst', { monsters: step.monsters.join(', '), roomName: step.name });
}

/** A step that gets an item: where the plan fetches it, and how. */
export type FetchStep = Extract<PlanStep, { kind: 'buy' | 'ask' | 'kill' }>;

export function isFetch(step: PlanStep): step is FetchStep {
  return step.kind === 'buy' || step.kind === 'ask' || step.kind === 'kill';
}

/**
 * What carrying out a fetch asks: buy at the counter; say the words, a
 * handover or the summons of the dropper (`summons`); or kill the dropper,
 * its summoner first where a death brings it (`summoner`).
 */
export type FetchAct =
  | { kind: 'buy' }
  | { kind: 'say'; say: string; summons?: string }
  | { kind: 'kill'; dropper: string; summoner?: string };

export function fetchAct(step: FetchStep): FetchAct {
  switch (step.kind) {
    case 'buy':
      return { kind: 'buy' };
    case 'ask':
      return { kind: 'say', say: step.say };
    case 'kill': {
      const summon = step.summon;
      if (summon === undefined) return { kind: 'kill', dropper: step.monster };
      return 'say' in summon
        ? { kind: 'say', say: summon.say, summons: step.monster }
        : { kind: 'kill', dropper: step.monster, summoner: summon.by };
    }
    default: {
      const never: never = step;
      return never;
    }
  }
}

/** A fetch, with the moves the plan walks to it from where the last one left off. */
export interface PlannedFetch {
  step: FetchStep;
  moves: number;
}

/** Why there is no plan: each thing the way wants that cannot be had, and why. */
export type PlanRefusal =
  /** No way there at all, holding every key the realm names. */
  | { kind: 'no-way'; why: string }
  /** The realm names nowhere the item comes from. */
  | { kind: 'no-source'; item: PlannedItem }
  /** Every source is somewhere this character cannot reach with what it holds by then. */
  | { kind: 'out-of-reach'; item: PlannedItem }
  /** The only sources are counters the purse does not cover. */
  | { kind: 'purse'; item: PlannedItem };

export type Plan =
  { kind: 'plan'; steps: PlanStep[]; cost: number } | { kind: 'refused'; refusals: PlanRefusal[] };

/** The steps that get an item, in the order the plan takes them. */
export function plannedFetches(plan: Plan): PlannedFetch[] {
  if (plan.kind === 'refused') return [];
  const fetches: PlannedFetch[] = [];
  let moves = 0;
  for (const step of plan.steps) {
    if (step.kind === 'walk') moves += step.route.steps.length;
    else if (isFetch(step)) {
      fetches.push({ step, moves });
      moves = 0;
    }
  }
  return fetches;
}

/** Why there is no plan, in words: each refusal, as a sentence fragment. */
export function planRefusalWords(refusal: PlanRefusal, t: UiLookup): string {
  switch (refusal.kind) {
    case 'no-way':
      return refusal.why.length > 0
        ? t('navigation.noWayBecause', { why: refusal.why })
        : t('navigation.noWay');
    case 'no-source':
      return t('navigation.noSource', { item: refusal.item.name });
    case 'out-of-reach':
      return t('navigation.outOfReach', { item: refusal.item.name });
    case 'purse':
      return t('navigation.purse', { item: refusal.item.name });
    default: {
      const never: never = refusal;
      return never;
    }
  }
}

/** Every refusal of a plan, in words. */
export function planRefusalsWords(refusals: readonly PlanRefusal[], t: UiLookup): string {
  return refusals.map((refusal) => planRefusalWords(refusal, t)).join('; ');
}
