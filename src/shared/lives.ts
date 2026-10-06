/**
 * Lives left, and when there are few enough that the client asks before
 * logging a character in (todo 07).
 *
 * GreaterMUD and Paradigm count a character's lives (`Lives/CP:` on the stat
 * sheet, `You have 8 lives left.` after a death). The rule here is the one
 * every reader of a lives floor shares: a floor of 0 never applies, and a count
 * never read is not low. `mudengine-session` › *A character low on lives is
 * asked about before it is logged in* has the rest.
 *
 * Dependency-free like everything in `shared/`.
 */
import { int } from './values';

/** A character file's `lowLives` when it says nothing: ask at two lives left. */
export const DEFAULT_LOW_LIVES = 2;

/** The highest floor a file may state, the bound `recoverGearFloor` has. */
const MAX_LOW_LIVES = 99;

/** Whether `lives` is at or below `floor`. A floor of 0 never is, and neither is an unread count. */
export function atLivesFloor(lives: number | null, floor: number): boolean {
  return floor > 0 && lives !== null && lives <= floor;
}

/** A file's or a field's `lowLives`, clamped to 0–99 as every count is; blank is the default. */
export function asLowLives(value: unknown): number {
  return int(value, DEFAULT_LOW_LIVES, 0, MAX_LOW_LIVES);
}

/**
 * What the player can answer: switch automation off and log in, log in as
 * things are, or stay offline.
 */
export const LOW_LIVES_ANSWERS = ['switch-off', 'log-in', 'stay'] as const;

export type LowLivesAnswer = (typeof LOW_LIVES_ANSWERS)[number];

/** A payload from a window as an answer, or null. */
export function asLowLivesAnswer(value: unknown): LowLivesAnswer | null {
  return LOW_LIVES_ANSWERS.find((answer) => answer === value) ?? null;
}
