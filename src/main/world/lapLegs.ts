/**
 * A lap's legs planned from plain data, on the route worker (`lapWorker.ts`)
 * or on main (the user, 2026-11-04): the Loops window's 3,447 shelf legs took
 * about 15 s of main's thread on Paradigm, one leg holding every keystroke
 * for up to 310 ms; on the worker they take 3.7 s. What crosses is the lap
 * traveller without its functions (`lapFunctions` rebuilds them), the purse,
 * and the fights answered so far; a fight the table lacks is answered as
 * unrun and said back (`asked`), and `planningLegs` plans those legs again.
 * See `mudengine-world` › *The lap index is planned on the route worker*.
 */
import type { FightOdds, RoomId } from '../../shared/world';
import { relocatingShare } from './relocating';
import type { NavigationOracle } from '../../shared/navigation';
import { leg } from './navigation/plan';
import { planRealmOf, type PlanWorld } from './navigation/realm';
import { affordsWith, type Purse } from './navigation/purse';
import type { Traveller } from './Router';
import type { WorldGraph } from './WorldGraph';

/** The traveller's fields that are functions: they cannot cross to a worker. */
type FunctionKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown ? K : never;
}[keyof T];

/** A traveller as plain data: every field a structured clone carries. */
export type PlainTraveller = Omit<Traveller, FunctionKeys<Traveller>>;

/** `traveller` without its functions. */
export function plainTraveller(traveller: Traveller): PlainTraveller {
  return Object.fromEntries(
    Object.entries(traveller).filter(([, value]) => typeof value !== 'function')
  ) as PlainTraveller;
}

/**
 * A room whose own spell moves the character is a wall for a lap
 * (`relocatingShare`), and every other room's spell costs it nothing
 * (`Errands.lapTraveller`).
 */
export function relocatingHazard(
  world: Pick<WorldGraph, 'hazardOf'> | undefined,
  level: number | null,
  keys: readonly number[] | undefined,
  spellsUp: readonly number[] | undefined
): NonNullable<Traveller['hazard']> {
  return (room, carrying = keys) => {
    const stated = world?.hazardOf(room, level) ?? null;
    return stated === null ? null : relocatingShare(stated, carrying, spellsUp);
  };
}

/** The functions a lap leg reads, built from the plain traveller (`Errands.lapTraveller`'s). */
export function lapFunctions(
  world: Pick<WorldGraph, 'hazardOf'> | undefined,
  plain: PlainTraveller
): Pick<Traveller, 'hazard' | 'shareOfHealth'> {
  return {
    hazard: relocatingHazard(world, plain.level ?? null, plain.keys, plain.spellsUp),
    shareOfHealth: () => 0
  };
}

/** One fight a plan asked about: a monster where it stands. */
export interface FightAsked {
  monster: string;
  room: RoomId;
}

/** A fight's place in the table of answers. */
export function fightKey(asked: FightAsked): string {
  return `${asked.room}\u0000${asked.monster}`;
}

/** What one batch of legs is planned with. Plain data: it crosses to the worker. */
export interface LapLegsAsk {
  traveller: PlainTraveller;
  purse: Purse;
  /** The answers to fights asked so far, by `fightKey`. */
  fights: Readonly<Record<string, FightOdds>>;
  legs: ReadonlyArray<readonly [RoomId, RoomId]>;
}

export interface LapLegsAnswer {
  /** Each leg's rooms, every step's both ends; none where no way was found. */
  rooms: RoomId[][];
  /** The fights asked that the table did not hold, each once. */
  asked: FightAsked[];
  /** The legs that asked one of them, so planned on an unrun fight. */
  unsure: number[];
}

type LapWorld = PlanWorld & Pick<WorldGraph, 'hazardOf' | 'shop' | 'priceAt'>;

/** One batch of a lap's legs, planned as `SessionManager.leg(…, { lap: true })` plans each. */
export function planLapLegs(world: LapWorld, ask: LapLegsAsk): LapLegsAnswer {
  const realm = planRealmOf(world);
  const traveller: Traveller = { ...ask.traveller, ...lapFunctions(world, ask.traveller) };
  const missed = new Map<string, FightAsked>();
  let missedHere = false;
  const oracle: NavigationOracle = {
    fight: (monster, room) => {
      const key = fightKey({ monster, room });
      const known = ask.fights[key];
      if (known !== undefined) return known;
      missed.set(key, { monster, room });
      missedHere = true;
      // As main's oracle answers a fight the odds book has not run.
      return { kind: 'unread' };
    },
    affords: (item, room) => affordsWith(world, ask.purse, item, room)
  };
  const unsure: number[] = [];
  const rooms = ask.legs.map(([from, to], index) => {
    missedHere = false;
    const route = leg(realm, oracle, from, to, traveller);
    if (missedHere) unsure.push(index);
    return route.steps.flatMap((step) => [step.from, step.to]);
  });
  return { rooms, asked: [...missed.values()], unsure };
}
