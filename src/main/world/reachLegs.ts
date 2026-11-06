/**
 * The quest reach's legs planned from plain data, on the route worker
 * (`lapWorker.ts`) or on main, as the lap's are (`lapLegs.ts`): the level each
 * step's room opens at. On main's thread a reach of 21 legs held every socket
 * for four seconds a leg, 37 s in one stretch (the host, 2026-11-06 UTC). What
 * crosses is the traveller without its risk or its functions, the health its
 * one-off hits are a share of, the purse and the fights answered so far. See
 * `mudengine-world` › `parts/quests.md` (todo 132).
 */
import { tuning } from '../app/tuning';
import type { FightOdds, Route, RoomId } from '../../shared/world';
import { leg } from './navigation/plan';
import { planRealmOf } from './navigation/realm';
import type { Purse } from './navigation/purse';
import {
  healthShare,
  tableOracle,
  type FightAsked,
  type LapWorld,
  type PlainTraveller
} from './lapLegs';
import type { Traveller } from './Router';
import type { WorldGraph } from './WorldGraph';

/** The level a room's way opens at; null where none walls it; `spent` where planning ran out of time. */
export type Opening = number | null | 'spent';

/** One walk held to `ms` of the thread: `spent` where it ran out. */
export type LegWithin = (
  from: RoomId,
  to: RoomId,
  traveller: Traveller,
  ms: number
) => Route | 'spent' | null;

/**
 * The traveller with the risk of the character as they stand taken off: what
 * a lair, a run past one and a room's own spell would cost now. The reach asks
 * which level opens a way, and those prices read the bar and the sheet as they
 * are now, which the level being tried changes neither of. A fight on the way
 * never refuses a plan (`mudengine-world` › *Survival never refuses a plan*),
 * so a way through a lair is a way. They were also the dearest part of every
 * step priced: a leg through the scatter mazes held the socket thread for over
 * a minute on the host (2026-10-29 UTC).
 */
export function levelsOnly(traveller: Traveller): Traveller {
  const {
    danger: _danger,
    runDeath: _runDeath,
    lairDamage: _lairDamage,
    hazard: _hazard,
    ...rest
  } = traveller;
  return rest;
}

/**
 * The lowest level a route's level walls ask for, or null where none stands
 * in it. On a refused route the walls are `blocks`; on a walkable one,
 * `blocks` is what a *cheaper* way needed and only `walls` binds.
 */
function levelWall(route: Route): number | null {
  const shut = route.blocked ? (route.blocks ?? []) : (route.walls ?? []);
  let level: number | null = null;
  for (const block of shut) {
    if (block.kind !== 'level' || block.minLevel === undefined) continue;
    level = level === null ? block.minLevel : Math.min(level, block.minLevel);
  }
  return level;
}

/**
 * The level the way to one room opens at, or null where no level wall stands
 * in it at this character's level. Each level wall met raises the traveller to
 * the lowest one and asks again, so a way past two walls (40, then 60) says
 * the one that opens it; `tries` bounds the climb, and `ms` all of the tries.
 */
export function openingLevel(
  legWithin: LegWithin,
  from: RoomId,
  to: RoomId,
  traveller: Traveller,
  tries: number,
  ms: number
): Opening {
  if (traveller.level === null || traveller.level === undefined) return null;
  const by = performance.now() + ms;
  let level = traveller.level;
  let opened: number | null = null;
  for (let tried = 0; tried < tries; tried += 1) {
    const left = by - performance.now();
    const way = left <= 0 ? 'spent' : legWithin(from, to, { ...traveller, level }, left);
    if (way === 'spent') return 'spent';
    const wall = way === null ? null : levelWall(way);
    if (wall === null || wall <= level) return opened;
    level = wall;
    opened = wall;
  }
  return opened;
}

/** What a reach is planned with, but the rooms and the fights: the session's half. */
export interface ReachBase {
  from: RoomId;
  /** `levelsOnly` of the character's traveller, its functions dropped. */
  traveller: PlainTraveller;
  /** The health a room command's one-off hit is a share of; null while unread. */
  health: number | null;
  purse: Purse;
}

/** One batch of the reach's rooms. Plain data: it crosses to the worker. */
export interface ReachLegsAsk extends ReachBase {
  /** The answers to fights asked so far, by `fightKey`. */
  fights: Readonly<Record<string, FightOdds>>;
  rooms: readonly RoomId[];
}

export interface ReachLegsAnswer {
  /** Each room's opening level, in the order asked. */
  levels: Opening[];
  /** The fights asked that the table did not hold, each once. */
  asked: FightAsked[];
  /** The rooms that asked one of them, so planned on an unrun fight. */
  unsure: number[];
}

/**
 * How the quest reach has its rooms planned: on the route worker, or on main
 * where there is none. `superseded` stops it between fight rounds once a later
 * ask replaced this one; what it answers then is read by nobody.
 */
export type PlanReach = (
  base: ReachBase,
  rooms: readonly RoomId[],
  superseded: () => boolean
) => Promise<Opening[]>;

export type ReachWorld = LapWorld & Pick<WorldGraph, 'budgeted'>;

/**
 * One batch of the reach's rooms, each held to `world.questReachLegMs` and
 * climbing at most `world.questReachTries` walls, as `Navigation.leg` plans a
 * walk with what is held now.
 */
export function planReachLegs(world: ReachWorld, ask: ReachLegsAsk): ReachLegsAnswer {
  const realm = planRealmOf(world);
  const traveller: Traveller = { ...ask.traveller, shareOfHealth: healthShare(ask.health) };
  const table = tableOracle(world, ask.purse, ask.fights);
  const legWithin: LegWithin = (from, to, as, ms) =>
    world.budgeted(ms, () => leg(realm, table.oracle, from, to, as)) ?? 'spent';
  const { questReachTries, questReachLegMs } = tuning().world;
  const unsure: number[] = [];
  const levels = ask.rooms.map((room, index) => {
    table.fresh();
    const opened = openingLevel(
      legWithin,
      ask.from,
      room,
      traveller,
      questReachTries,
      questReachLegMs
    );
    if (table.missedHere()) unsure.push(index);
    return opened;
  });
  return { levels, asked: table.asked(), unsure };
}
