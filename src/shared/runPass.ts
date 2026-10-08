/**
 * What running past lairs risks (todos 15 and 23): the rounds a lair's
 * monsters get in on a character walking through with combat off, and the
 * chance those rounds kill. Server rules from GreaterMUD's source, read
 * 2026-10-05 and 2026-10-07; the reasoning is in `mudengine-world` ›
 * *A lair is priced as a run*.
 */
import { moveDelayMs } from './hunting';
import type { RealmFamily } from './realm';
import type { SurvivalHorizon } from './survival';
import type { RoomId } from './world';

/** One lair a run passes. */
export interface RunLair {
  room: RoomId;
  name: string;
  /** Rounds of the lair's blows a pass is expected to take, followers included (`runRounds`). */
  rounds: number;
  /** The chance the pass kills, from the odds book's fight; null where it has not run. */
  death: number | null;
}

/** A run's whole risk: the chance of dying on the way, null where any lair is unknown. */
export interface RunRisk {
  death: number | null;
  lairs: RunLair[];
}

/** How a lair's monsters get at a runner (`runRounds`). */
export interface RunExposure {
  /** Combat ticks in one room's stay: the move delay over the round, past 1 on a fast realm. */
  ticks: number;
  /** Rounds of blows the first tick lands: an idle lair monster banks energy (`Mob.cs:1797`). */
  firstRounds: number;
  /** Rooms the lair's monsters are expected to follow on for (`followRooms`). */
  followRooms: number;
}

/**
 * Combat ticks while the character is in a room: the move delay
 * (`MoveCommand.cs:40`) over the round (`TimedEventManager.cs:22`). Leaving
 * costs nothing else (`Exits.cs:72-81`), so this is the whole exposure of one
 * pass. Above 1 where the round is shorter than a step.
 */
export function ticksIn(moveMs: number, roundMs: number): number {
  if (roundMs <= 0) return 1;
  return Math.max(0, moveMs / roundMs);
}

/** The chance a room's combat tick lands while the character is in it: `ticksIn`, at most one. */
export function caughtChance(moveMs: number, roundMs: number): number {
  return Math.min(1, ticksIn(moveMs, roundMs));
}

/** The move delay with a pack this heavy, an unweighed pack priced full: the slowest step. */
function passMoveMs(
  encumbrance: number | null,
  encumbranceMax: number | null,
  family: RealmFamily | null,
  stepMs: number
): number {
  return encumbrance === null || encumbranceMax === null
    ? moveDelayMs(1, 1, family, stepMs)
    : moveDelayMs(encumbrance, encumbranceMax, family, stepMs);
}

/** `caughtChance` of the move delay with a pack this heavy (`passMoveMs`). */
export function passCaught(
  encumbrance: number | null,
  encumbranceMax: number | null,
  family: RealmFamily | null,
  stepMs: number,
  roundMs: number
): number {
  return caughtChance(passMoveMs(encumbrance, encumbranceMax, family, stepMs), roundMs);
}

/** `ticksIn` of the move delay with a pack this heavy (`passMoveMs`). */
export function passTicks(
  encumbrance: number | null,
  encumbranceMax: number | null,
  family: RealmFamily | null,
  stepMs: number,
  roundMs: number
): number {
  return ticksIn(passMoveMs(encumbrance, encumbranceMax, family, stepMs), roundMs);
}

/**
 * The chance a sneak holds through one move: `Exits.cs:144` rolls
 * min(Stealth, 100) − (players + monsters in the room left) against 1..100,
 * with no 95 cap. Zero where the Stealth figure is unread.
 */
export function sneakHolds(stealth: number | null, others: number): number {
  if (stealth === null) return 0;
  return Math.min(1, Math.max(0, (Math.min(stealth, 100) - Math.max(0, others)) / 100));
}

/**
 * Rooms a monster is expected to stay on the runner for, over the next
 * `rooms` moves: it follows a move on `follows`% rolled twice, leaving and
 * arriving (`Exits.cs:166-185,262-267`), so it is still there after k moves
 * at (f²)^k. A follow rate nobody has read follows every move.
 */
export function followRooms(follows: number | null, rooms: number): number {
  const f = follows === null ? 1 : Math.min(1, Math.max(0, follows / 100));
  const stays = f * f;
  let expected = 0;
  let still = 1;
  for (let k = 0; k < rooms; k++) {
    still *= stays;
    expected += still;
  }
  return expected;
}

/**
 * Rounds of a lair's blows one run past it takes: the first tick, landing
 * `min(1, ticks)` of the time with the banked rounds, any further ticks of
 * the stay, and each room a follower stays on at the same ticks.
 */
export function runRounds({ ticks, firstRounds, followRooms }: RunExposure): number {
  return Math.min(1, ticks) * firstRounds + Math.max(0, ticks - 1) + followRooms * ticks;
}

/**
 * The share still standing after this many rounds of the fight, read off its
 * horizons: everyone is standing before the first blow, linear between the
 * rounds read, and the last horizon held past its end.
 */
export function standingAfter(horizons: readonly SurvivalHorizon[], rounds: number): number {
  if (rounds <= 0) return 1;
  let lastRounds = 0;
  let lastStanding = 1;
  for (const horizon of [...horizons].sort((a, b) => a.rounds - b.rounds)) {
    if (rounds <= horizon.rounds) {
      const along = (rounds - lastRounds) / Math.max(horizon.rounds - lastRounds, 1e-9);
      return lastStanding + (horizon.standing - lastStanding) * along;
    }
    lastRounds = horizon.rounds;
    lastStanding = horizon.standing;
  }
  return lastStanding;
}

/**
 * The chance of dying somewhere on the way: one minus surviving every lair.
 * Null where a lair that gets a round in has no figure for it.
 */
export function runDeath(lairs: readonly RunLair[]): number | null {
  let lives = 1;
  for (const lair of lairs) {
    if (lair.rounds <= 0) continue;
    if (lair.death === null) return null;
    lives *= 1 - lair.death;
  }
  return 1 - lives;
}
