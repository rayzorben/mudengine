/**
 * What running past lairs risks (todo 15): the chance a lair on the way gets a
 * round in, and the chance that round kills. Server rules from GreaterMUD's
 * source, read 2026-10-05; the reasoning is in `mudengine-automation` ›
 * *A hunt order can be run to its start*.
 */
import type { RoomId } from './world';

/** One lair a run passes. */
export interface RunLair {
  room: RoomId;
  name: string;
  /** The chance its monsters swing while the character is in the room, 0..1. */
  caught: number;
  /** The chance one caught round kills, from the odds book's first round; null where it has not run. */
  kills: number | null;
}

/** A run's whole risk: the chance of dying on the way, null where any lair is unknown. */
export interface RunRisk {
  death: number | null;
  lairs: RunLair[];
}

/**
 * The chance a room's combat tick lands while the character is in it: the
 * move delay (`MoveCommand.cs:40`) over the round (`TimedEventManager.cs:327`).
 * Leaving costs nothing else, so this is the whole exposure of one pass. The
 * walk's own timing (`OffRounds`) is not counted: rooms tick in groups a
 * second apart (`RoomManager.cs:74`), so the beat it times to can be wrong.
 */
export function caughtChance(moveMs: number, roundMs: number): number {
  if (roundMs <= 0) return 1;
  return Math.min(1, Math.max(0, moveMs / roundMs));
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
 * The chance of dying somewhere on the way: one minus surviving every lair,
 * where each lair kills with `caught × kills`. Null where a lair that can
 * catch the character has no figure for its round.
 */
export function runDeath(lairs: readonly RunLair[]): number | null {
  let lives = 1;
  for (const lair of lairs) {
    if (lair.caught <= 0) continue;
    if (lair.kills === null) return null;
    lives *= 1 - lair.caught * lair.kills;
  }
  return 1 - lives;
}
