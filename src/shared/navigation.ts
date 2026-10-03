/**
 * A plan to get somewhere, made whole before the first step: every key the
 * way wants and where each comes from, in the order they can be had, the
 * fights it takes, and the walk between. Or the reasons there is none, each
 * named. Made by the one navigation engine (`main/world/navigation/plan.ts`);
 * `mudengine-world` › *There is one navigation engine*.
 */
import type { UiLookup } from './i18n';
import type { RoomId, Route } from './world';

/** Whether this character wins a fight, as combat would weigh it before opening. */
export type FightOdds =
  | { kind: 'win' }
  | { kind: 'lose'; survives: number }
  /** The simulator has not finished the fight yet. */
  | { kind: 'unread' };

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
  /** Kill `monster` here for the item; `summon` brings it first. */
  | {
      kind: 'kill';
      item: PlannedItem;
      monster: string;
      room: RoomId;
      summon?: { say: string } | { by: string };
    }
  /** Kill what stands in this room, which a way through it wants empty (`nomonsters`). */
  | ClearStep;

export interface ClearStep {
  kind: 'clear';
  room: RoomId;
  name: string;
  monsters: string[];
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
  /** The only sources are fights this character loses. */
  | { kind: 'fight'; item: PlannedItem | null; monster: string; survives: number }
  /** A fight the simulator has not finished; asked again shortly. */
  | { kind: 'odds-unread'; item: PlannedItem | null; monster: string }
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
    case 'fight': {
      const survives = `${Math.round(refusal.survives * 100)}%`;
      return refusal.item === null
        ? t('navigation.fightInTheWay', { monster: refusal.monster, survives })
        : t('navigation.fightForItem', {
            item: refusal.item.name,
            monster: refusal.monster,
            survives
          });
    }
    case 'odds-unread':
      return t('navigation.oddsUnread', { monster: refusal.monster });
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
